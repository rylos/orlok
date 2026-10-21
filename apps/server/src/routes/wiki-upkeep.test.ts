import type {
  Conversation,
  ConversationSummary,
  ModelProvider,
  Office,
  WikiPage,
  WikiPageHealth,
  WikiReviewItem,
  WikiSearchResult,
  WikiSource,
  WorkspaceOffice,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { conversations } from "../db/schema";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { checkWikiPages } from "../services/wiki-check";
import { processNextWikiSource } from "../services/wiki-ingest";
import { reflectOnConversations } from "../services/wiki-reflect";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

// The wiki upkeep techniques (R-MEM-13 to R-MEM-16): outdated pages kept
// and marked, protected rewrites, checks without a model, critical reading, ingest outcome and
// proposals from quiet conversations.

const deps = createTestDeps();
const requests: ChatRequest[] = [];
let script: ChatChunk[][] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push({ ...request, messages: [...request.messages] });
    for (const chunk of script.shift() ?? [{ type: "text", text: "OK" }]) {
      yield chunk;
    }
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });
const worker = {
  db: deps.db,
  config: deps.config,
  llm: fakeLlm,
  localEmbedder: deps.localEmbedder,
};

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  script = [];
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function setup() {
  const provider = await call<ModelProvider>("/admin/providers", "POST", {
    name: "Provider",
    kind: "anthropic",
    apiKey: "x",
  });
  const { id: profileId } = (
    await call<{ id: string }>("/admin/profiles", "POST", {
      name: "Profile",
      providerId: provider.body.id,
      model: "model",
      mode: "ask",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT Services" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Helpdesk",
    })
  ).body;
  const page = (slug: string, title: string, content: string, extra: object = {}) =>
    call<WikiPage>(`/offices/${office.id}/wiki/pages`, "POST", {
      slug,
      title,
      content,
      ...extra,
    });
  return { office, colleague, page };
}

function toolCall(name: string, input: unknown, id = `call-${name}`): ChatChunk {
  return { type: "tool_calls", calls: [{ id, name, input }] };
}

// Runs one chat turn in which the colleague calls the given tools, and returns their results.
async function useTools(colleagueId: string, calls: ChatChunk[]) {
  script = [...calls.map((chunk) => [chunk]), [{ type: "text", text: "Done." }]];
  const conversation = await call<ConversationSummary>("/conversations", "POST", { colleagueId });
  const res = await app.request(
    `/api/conversations/${conversation.body.id}/messages`,
    jsonRequest("POST", { content: "Update the wiki." }, adminCookie),
  );
  parseSse(await res.text());
  return requests.slice(1).map((request) => {
    const last = request.messages.at(-1);
    return last?.role === "tool" ? last.results[0] : null;
  });
}

const longText = (line: string) =>
  Array.from({ length: 60 }, (_, index) => `${line} ${index} of the page, kept as it is.`).join(
    "\n",
  );

describe("outdated pages", () => {
  it("keeps the status and the verification date of a page through its revisions", async () => {
    const { office, page } = await setup();
    await page("vpn-old", "VPN OpenVPN", "Old setup.", {
      status: "superseded",
      verifiedOn: "2025-03-01",
    });
    const saved = await call<WikiPage>(`/offices/${office.id}/wiki/pages/vpn-old`);
    expect(saved.body).toMatchObject({ status: "superseded", verifiedOn: "2025-03-01" });

    const updated = await call<WikiPage>(`/offices/${office.id}/wiki/pages/vpn-old`, "PATCH", {
      baseRevision: 1,
      status: "current",
    });
    expect(updated.body).toMatchObject({ status: "current", verifiedOn: "2025-03-01" });
    // Restoring the first revision brings its status back.
    const restored = await call<WikiPage>(
      `/offices/${office.id}/wiki/pages/vpn-old/revisions/1/restore`,
      "POST",
    );
    expect(restored.body.status).toBe("superseded");
  });

  it("finds outdated pages after current ones, and uses the office's synonyms", async () => {
    const { office, page } = await setup();
    await page("vpn-openvpn", "VPN configuration (OpenVPN)", "VPN with OpenVPN.", {
      status: "superseded",
    });
    await page("vpn-wireguard", "VPN configuration (WireGuard)", "VPN with WireGuard.");
    const found = await call<WikiSearchResult[]>(
      `/offices/${office.id}/wiki/search?q=vpn+configuration`,
    );
    expect(found.body.map((result) => result.slug)).toEqual(["vpn-wireguard", "vpn-openvpn"]);
    expect(found.body[1]?.status).toBe("superseded");

    await page("tunnel", "Tunnel to the warehouse", "Site to site link.");
    const before = await call<WikiSearchResult[]>(`/offices/${office.id}/wiki/search?q=vpn`);
    expect(before.body.map((result) => result.slug)).not.toContain("tunnel");
    await call(`/offices/${office.id}/wiki/synonyms`, "PUT", {
      synonyms: "# ours\nvpn, tunnel, site to site",
    });
    const after = await call<WikiSearchResult[]>(`/offices/${office.id}/wiki/search?q=vpn`);
    expect(after.body.map((result) => result.slug)).toContain("tunnel");
    expect(
      (await call<{ synonyms: string }>(`/offices/${office.id}/wiki`)).body.synonyms,
    ).toContain("tunnel");
  });
});

describe("protected writes by colleagues", () => {
  it("replaces an exact passage with wiki_edit, and refuses an ambiguous one", async () => {
    const { office, colleague, page } = await setup();
    await page("ups", "UPS", "Battery: 2019.\nRuntime: 6 minutes.\nRuntime: see the log.");
    const results = await useTools(colleague.id, [
      toolCall("wiki_edit", { slug: "ups", old_text: "Runtime", new_text: "Autonomy" }, "a"),
      toolCall("wiki_edit", { slug: "ups", old_text: "Battery: 2018", new_text: "x" }, "b"),
      toolCall(
        "wiki_edit",
        { slug: "ups", old_text: "Battery: 2019.", new_text: "Battery: 2026 (replaced)." },
        "c",
      ),
    ]);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.content).toContain("appears 2 times");
    expect(results[1]?.content).toContain("does not appear");
    expect(results[2]).toMatchObject({ isError: false });
    const saved = await call<WikiPage>(`/offices/${office.id}/wiki/pages/ups`);
    expect(saved.body.content).toBe(
      "Battery: 2026 (replaced).\nRuntime: 6 minutes.\nRuntime: see the log.",
    );
    expect(saved.body.revision).toBe(2);
  });

  it("refuses a rewrite that drops most of a long page, and reports lost values", async () => {
    const { office, colleague, page } = await setup();
    const content = `${longText("Line")}\nweb01 → 10.0.1.10\nSee [[ups]].`;
    await page("servers", "Servers", content);
    const results = await useTools(colleague.id, [
      toolCall(
        "wiki_write",
        { slug: "servers", title: "Servers", content: "Short.", base_revision: 1 },
        "a",
      ),
      toolCall(
        "wiki_write",
        {
          slug: "servers",
          title: "Servers",
          content: `${longText("Line")}\nweb01 moved.`,
          base_revision: 1,
        },
        "b",
      ),
    ]);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.content).toContain("allow_shrink");
    expect(results[1]).toMatchObject({ isError: false });
    expect(results[1]?.content).toContain("[[ups]]");
    expect(results[1]?.content).toContain("10.0.1.10");
    expect((await call<WikiPage>(`/offices/${office.id}/wiki/pages/servers`)).body.revision).toBe(
      2,
    );
  });

  it("tells the colleague the date, and how to mark what is no longer true", async () => {
    const { colleague } = await setup();
    await useTools(colleague.id, []);
    expect(requests[0]?.system).toContain(`Today is ${new Date().toISOString().slice(0, 10)}.`);
    expect(requests[0]?.system).toContain("**Superseded (YYYY-MM-DD):**");
  });
});

describe("fixing the review with a colleague", () => {
  it("tells the page which colleague the person talked with last", async () => {
    const { office, colleague } = await setup();
    const other = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.id,
        name: "Other",
        profileId: colleague.profileId,
      })
    ).body;
    await call("/conversations", "POST", { colleagueId: colleague.id });
    const offices = await call<WorkspaceOffice[]>("/workspace/offices");
    const colleagues = offices.body.find((item) => item.id === office.id)?.colleagues ?? [];
    expect(colleagues.find((item) => item.id === colleague.id)?.lastTalkedAt).toEqual(
      expect.any(String),
    );
    expect(colleagues.find((item) => item.id === other.id)?.lastTalkedAt).toBeNull();
  });

  it("lets the colleague list the open items and close them in the name of a manager", async () => {
    const { office, colleague, page } = await setup();
    await page("lonely", "Lonely page", "Nothing links here.");
    await call(`/offices/${office.id}/wiki/review/lint`, "POST");
    const [item] = (await call<WikiReviewItem[]>(`/offices/${office.id}/wiki/review?status=open`))
      .body;
    const results = await useTools(colleague.id, [
      toolCall("wiki_review_list", {}, "a"),
      toolCall("wiki_review_close", { id: item?.id, status: "done" }, "b"),
    ]);
    expect(results[0]?.content).toContain(`id ${item?.id} · isolated_page · Lonely page`);
    expect(results[1]).toMatchObject({ isError: false });
    const done = await call<WikiReviewItem[]>(`/offices/${office.id}/wiki/review?status=done`);
    expect(done.body).toMatchObject([{ id: item?.id, resolvedBy: "Administrator" }]);
  });
});

describe("checks without a model", () => {
  it("reports address conflicts, stale verifications, relative dates and hosts without a page", async () => {
    const { office, page } = await setup();
    await page("network", "Network", "| Host | IP |\n|---|---|\n| nas01 | 10.0.0.20 |");
    await page("backup", "Backup", "nas01: 10.0.0.21, the target of every backup.", {
      verifiedOn: "2020-01-01",
    });
    await page("printers", "Printers", "The plotter currently prints in black only.");
    for (const slug of ["a", "b", "c", "d"]) {
      await page(
        `note-${slug}`,
        `Note ${slug}`,
        `Files go to fileserver7 (fileserver7 = 10.0.0.7).`,
      );
    }
    await call(`/offices/${office.id}/wiki/review/lint`, "POST");
    const items = await call<WikiReviewItem[]>(`/offices/${office.id}/wiki/review?status=open`);
    const byKind = (kind: string) => items.body.filter((item) => item.kind === kind);
    expect(byKind("ip_conflict")).toMatchObject([
      { title: "nas01", slugs: expect.arrayContaining(["network", "backup"]) },
    ]);
    expect(byKind("stale_page").map((item) => item.slugs)).toEqual([["backup"]]);
    expect(byKind("relative_date")).toMatchObject([
      { slugs: ["printers"], detail: expect.stringContaining("currently") },
    ]);
    expect(byKind("missing_entity")).toMatchObject([{ title: "fileserver7" }]);

    const health = await call<WikiPageHealth[]>(`/offices/${office.id}/wiki/health`);
    const backup = health.body.find((item) => item.slug === "backup");
    expect(backup?.problems).toEqual(
      expect.arrayContaining(["stale", "no_links", "no_backlinks", "open_reviews"]),
    );
    expect(backup?.score).toBeLessThan(50);
    // Worst first.
    expect(health.body.map((item) => item.score)).toEqual(
      [...health.body.map((item) => item.score)].sort((x, y) => x - y),
    );
  });
});

describe("critical reading", () => {
  it("raises findings whose quote is really in the page, and reads a page again only once changed", async () => {
    const { office, colleague, page } = await setup();
    const content = `${longText("Detail")}\nThe NAS currently runs DSM 6.\nSince 2026-05 the NAS runs DSM 7.`;
    await page("nas", "NAS", content);
    script = [
      [
        {
          type: "text",
          text: JSON.stringify({
            issues: [
              { quote: "The NAS currently runs DSM 6.", problem: "Later the page says DSM 7." },
              { quote: "The NAS is in rack 3.", problem: "Invented." },
            ],
          }),
        },
      ],
    ];
    expect(await checkWikiPages(worker, office.id, colleague.id)).toEqual({ pages: 1, raised: 1 });
    const items = await call<WikiReviewItem[]>(`/offices/${office.id}/wiki/review?status=open`);
    expect(items.body).toMatchObject([
      {
        kind: "check",
        slugs: ["nas"],
        raisedBy: "Helpdesk",
        detail: expect.stringContaining("DSM 6"),
      },
    ]);
    // Unchanged: not read again.
    expect(await checkWikiPages(worker, office.id, colleague.id)).toEqual({ pages: 0, raised: 0 });

    // Closed by a person, it does not come back even if the model says it again.
    await call(`/offices/${office.id}/wiki/review/${items.body[0]?.id}`, "PATCH", {
      status: "done",
    });
    await call(`/offices/${office.id}/wiki/pages/nas`, "PATCH", {
      baseRevision: 1,
      content: `${content}\n`,
    });
    script = [
      [
        {
          type: "text",
          text: JSON.stringify({
            issues: [{ quote: "The NAS currently runs DSM 6.", problem: "Still there." }],
          }),
        },
      ],
    ];
    expect(await checkWikiPages(worker, office.id, colleague.id)).toEqual({ pages: 1, raised: 0 });

    expect(
      (await call(`/offices/${office.id}/wiki/review/check`, "POST", { colleagueId: colleague.id }))
        .res.status,
    ).toBe(202);
  });
});

describe("ingest outcome", () => {
  it("files nothing when the analysis finds nothing new, and records it", async () => {
    const { office, colleague, page } = await setup();
    await page("backup", "Backup", "Nightly backup to PBS at 23:00.");
    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append("files", new File(["Nightly backup to PBS at 23:00."], "backup.md"));
    await app.request(`/api/offices/${office.id}/wiki/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });
    script = [[{ type: "text", text: "## Summary\nBackup time.\n\n## Outcome\nnothing" }]];
    expect(await processNextWikiSource(worker)).toBe(true);
    // Only the analysis was asked: no filing.
    expect(requests).toHaveLength(1);
    const sources = await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`);
    expect(sources.body[0]).toMatchObject({ status: "done", outcome: "nothing" });
  });
});

describe("proposals from quiet conversations", () => {
  it("proposes what to keep to the person only, who saves it or lets it go", async () => {
    const { office, colleague } = await setup();
    const conversation = (
      await call<ConversationSummary>("/conversations", "POST", { colleagueId: colleague.id })
    ).body;
    for (const content of ["Printer offline", "It is the HP", "Restarted spooler", "Works now"]) {
      script = [[{ type: "text", text: "Ok." }]];
      const res = await app.request(
        `/api/conversations/${conversation.id}/messages`,
        jsonRequest("POST", { content }, adminCookie),
      );
      await res.text();
    }
    const quietSince = new Date(Date.now() - 2 * 60 * 60_000);
    await deps.db
      .update(conversations)
      .set({ updatedAt: quietSince })
      .where(eq(conversations.id, conversation.id));

    requests.length = 0;
    script = [
      [
        {
          type: "text",
          text: JSON.stringify({
            candidates: [
              { title: "HP printer offline", summary: "Restarting the spooler fixes it." },
            ],
          }),
        },
      ],
    ];
    expect(await reflectOnConversations(worker)).toBe(1);
    expect(requests[0]?.messages[0]).toMatchObject({
      content: expect.stringContaining("PERSON: Restarted spooler"),
    });
    // Read once: nothing more until the conversation changes.
    expect(await reflectOnConversations(worker)).toBe(0);

    const read = await call<Conversation>(`/conversations/${conversation.id}`);
    expect(read.body.wikiCandidates).toEqual([
      { title: "HP printer offline", summary: "Restarting the spooler fixes it.", slug: null },
    ]);
    // The conversation keeps its place in the list.
    expect(read.body.updatedAt).toBe(quietSince.toISOString());

    const saved = await call<WikiSource>(
      `/conversations/${conversation.id}/wiki-candidates/0`,
      "POST",
    );
    expect(saved.res.status).toBe(201);
    expect(saved.body).toMatchObject({ status: "queued", title: "HP printer offline" });
    expect(
      (await call<Conversation>(`/conversations/${conversation.id}`)).body.wikiCandidates,
    ).toEqual([]);
    expect(
      (await call(`/conversations/${conversation.id}/wiki-candidates/0`, "DELETE")).res.status,
    ).toBe(404);
    expect(office.id).toBeTruthy();
  });

  it("leaves alone short conversations and those that already wrote to the wiki", async () => {
    const { colleague } = await setup();
    const conversation = (
      await call<ConversationSummary>("/conversations", "POST", { colleagueId: colleague.id })
    ).body;
    const res = await app.request(
      `/api/conversations/${conversation.id}/messages`,
      jsonRequest("POST", { content: "Hi" }, adminCookie),
    );
    await res.text();
    await deps.db
      .update(conversations)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(eq(conversations.id, conversation.id));
    requests.length = 0;
    expect(await reflectOnConversations(worker)).toBe(1);
    expect(requests).toHaveLength(0);
  });
});
