import type {
  ApiError,
  ConversationMessage,
  ConversationSummary,
  CostOverview,
  ModelProvider,
  Office,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { auditEvents, modelUsage, users } from "../db/schema";
import type { LlmClientFactory } from "../llm";
import { csvCell } from "../ops/audit";
import { costMicros, monthOf } from "../services/costs";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

// Model usage, prices and spending limits (R-MOD-4), audit export (R-SEC-5).

const deps = createTestDeps();

// Every call reports 1,000 prompt tokens, 400 of them read from the cache, and 100 output tokens.
const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat() {
    yield { type: "text", text: "Fatto." };
    yield {
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 400 },
    };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function setup(kind: "anthropic" | "ollama" = "anthropic") {
  const provider = (
    await call<ModelProvider>("/admin/providers", "POST", {
      name: "Provider",
      kind,
      ...(kind === "anthropic" ? { apiKey: "x" } : {}),
    })
  ).body;
  const { id: profileId } = (
    await call<{ id: string }>("/admin/profiles", "POST", {
      name: "Profile",
      providerId: provider.id,
      model: "model",
      maxOutputTokens: 1_000,
      mode: "ask",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "Servizi IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Mary",
    })
  ).body;
  return { provider, office, colleague };
}

async function ask(colleagueId: string, content = "Ciao") {
  const conversation = (await call<ConversationSummary>("/conversations", "POST", { colleagueId }))
    .body;
  const res = await app.request(
    `/api/conversations/${conversation.id}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
  parseSse(await res.text());
  const messages = (
    await call<{ messages: ConversationMessage[] }>(`/conversations/${conversation.id}`)
  ).body.messages;
  return messages.at(-1);
}

const rates = { input: 3, cachedInput: 0.3, cacheWrite: null, output: 15 };

describe("cost of a call", () => {
  it("prices cached input and cache writes at their own rates, the rest at the input rate", () => {
    // 600 plain × 3 + 400 cached × 0.3 + 100 output × 15 = 1,800 + 120 + 1,500 micros.
    expect(
      costMicros({ inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 400 }, rates),
    ).toBe(3_420);
    // Without their own rates cache tokens cost what input costs.
    expect(
      costMicros(
        { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 500 },
        { input: 3, cachedInput: null, cacheWrite: null, output: 15 },
      ),
    ).toBe(3_000);
  });
});

describe("usage ledger", () => {
  it("records every call, unpriced until the model has a price, never as zero", async () => {
    const { provider, office, colleague } = await setup();
    await ask(colleague.id);

    let rows = await deps.db.select().from(modelUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "chat",
      officeId: office.id,
      colleagueId: colleague.id,
      model: "model",
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
      costStatus: "unpriced",
      costMicros: null,
    });

    const saved = await call("/admin/costs/prices", "PUT", {
      providerId: provider.id,
      model: "model",
      rates,
    });
    expect(saved.res.status).toBe(204);
    await ask(colleague.id);
    rows = await deps.db.select().from(modelUsage).where(eq(modelUsage.costStatus, "priced"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costMicros: 3_420, rates });

    const overview = (await call<CostOverview>("/admin/costs")).body;
    expect(overview.report).toMatchObject({
      month: monthOf(new Date()),
      totalMicros: 3_420,
      calls: 2,
      unpricedCalls: 1,
    });
    expect(overview.report.byOffice).toEqual([
      expect.objectContaining({ label: "Servizi IT", costMicros: 3_420, calls: 2 }),
    ]);
    expect(overview.report.byPurpose.map((line) => line.key)).toEqual(["chat"]);
    // A price applies from when it is saved: the earlier call stays unpriced.
    expect(overview.prices).toEqual([
      expect.objectContaining({ model: "model", rates, unpricedCalls: 1 }),
    ]);
    // Changes to prices are in the installation log.
    const events = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "cost.price_set"));
    expect(events).toHaveLength(1);
  });

  it("marks local models as included", async () => {
    const { provider, colleague } = await setup("ollama");
    expect((await call<CostOverview>("/admin/costs")).body.providers).toEqual([
      { id: provider.id, name: "Provider", billing: "included" },
    ]);
    await ask(colleague.id);
    const [row] = await deps.db.select().from(modelUsage);
    expect(row).toMatchObject({ costStatus: "included", costMicros: null });
  });
});

describe("spending limits", () => {
  it("stops calls for a person over their limit, tells administrators once, and lets the playground through", async () => {
    const { provider, colleague } = await setup();
    await call("/admin/costs/prices", "PUT", { providerId: provider.id, model: "model", rates });
    const [admin] = await deps.db.select().from(users);
    // 0.005 dollars: one call (0.00342) passes, the second crosses it, the third is refused.
    const saved = await call("/admin/costs/budgets", "PUT", {
      scope: "person",
      scopeId: admin?.id,
      monthlyLimit: 0.005,
      warnPercent: 50,
    });
    expect(saved.res.status).toBe(204);

    expect((await ask(colleague.id))?.status).toBe("complete");
    expect((await ask(colleague.id))?.status).toBe("complete");
    const refused = await ask(colleague.id);
    expect(refused).toMatchObject({ status: "error", errorCode: "budget_exceeded" });
    expect(await deps.db.select().from(modelUsage)).toHaveLength(2);

    const actions = (await deps.db.select().from(auditEvents)).map((event) => event.action);
    expect(actions.filter((action) => action === "budget.warning")).toHaveLength(1);
    expect(actions.filter((action) => action === "budget.exceeded")).toHaveLength(1);

    const overview = (await call<CostOverview>("/admin/costs")).body;
    expect(overview.budgets).toEqual([
      expect.objectContaining({
        scope: "person",
        scopeName: "Administrator",
        spentMicros: 6_840,
        monthlyLimitMicros: 5_000,
      }),
    ]);

    const profileId = (await call<{ id: string }[]>("/admin/profiles")).body[0]?.id;
    const playground = await app.request(
      "/api/admin/playground",
      jsonRequest(
        "POST",
        { profileId, messages: [{ role: "user", content: "Prova" }] },
        adminCookie,
      ),
    );
    expect(await playground.text()).toContain("Fatto.");
    expect(await deps.db.select().from(modelUsage)).toHaveLength(3);

    // Raising the limit applies at the next call; nothing has to be resumed.
    await call("/admin/costs/budgets", "PUT", {
      scope: "person",
      scopeId: admin?.id,
      monthlyLimit: 10,
      warnPercent: 80,
    });
    expect((await ask(colleague.id))?.status).toBe("complete");

    const id = (await call<CostOverview>("/admin/costs")).body.budgets[0]?.id;
    expect((await call(`/admin/costs/budgets/${id}`, "DELETE")).res.status).toBe(204);
    expect((await call<CostOverview>("/admin/costs")).body.budgets).toEqual([]);
  });

  it("validates limits", async () => {
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    const missingScope = await call<ApiError>("/admin/costs/budgets", "PUT", {
      scope: "office",
      scopeId: null,
      monthlyLimit: 10,
      warnPercent: 80,
    });
    expect(missingScope.res.status).toBe(400);
    const ok = await call("/admin/costs/budgets", "PUT", {
      scope: "office",
      scopeId: office.id,
      monthlyLimit: 10,
      warnPercent: 80,
    });
    expect(ok.res.status).toBe(204);
  });
});

describe("audit export", () => {
  it("neutralizes cells a spreadsheet would run", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("plain")).toBe("plain");
  });

  it("exports the whole log as CSV and records the export", async () => {
    await setup();
    const res = await app.request(
      "/api/admin/audit/export?format=csv",
      jsonRequest("GET", undefined, adminCookie),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(".csv");
    // The byte order mark makes Excel read the file as UTF-8; text() drops it.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.split("\r\n")[0]).toBe(
      "createdAt,office,actorKind,actor,colleagueOwner,action,target,detail",
    );
    const jsonl = await app.request(
      "/api/admin/audit/export?format=jsonl",
      jsonRequest("GET", undefined, adminCookie),
    );
    const lines = (await jsonl.text())
      .split("\n")
      .map((line: string) => JSON.parse(line) as { action: string });
    expect(lines.at(-1)?.action).toBe("audit.exported");
  });
});
