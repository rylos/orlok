import type {
  Conversation,
  ConversationSummary,
  ModelProvider,
  Office,
  WikiLintResult,
  WikiOverview,
  WikiPage,
  WikiReviewItem,
  WikiSource,
  WikiSourceDeleteResult,
  WikiSourceUploadResult,
} from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { lintAllOffices } from "../services/wiki-review";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

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
    yield { type: "done", stopReason: "end_turn", usage: null };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });

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
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Helpdesk",
    })
  ).body;
  const wiki = `/offices/${office.id}/wiki`;
  const page = (body: Record<string, unknown>) => call<WikiPage>(`${wiki}/pages`, "POST", body);
  return { office, colleague, wiki, page };
}

describe("wiki review queue", () => {
  // Conversations never trigger the lint a filed document does: every office is linted once a
  // night, once per day whatever the restarts (R-MEM-7).
  it("lints every office once a night", async () => {
    const { wiki, page } = await setup();
    await page({ title: "Lonely", content: "Nobody links here." });
    const night = new Date();
    night.setHours(3, 0, 0, 0);
    const early = new Date(night);
    early.setHours(1);
    expect(await lintAllOffices(deps.db, early)).toBe(false);
    expect(await lintAllOffices(deps.db, night)).toBe(true);
    expect(await lintAllOffices(deps.db, night)).toBe(false);
    const open = (await call<WikiReviewItem[]>(`${wiki}/review?status=open`)).body;
    expect(open.map((item) => `${item.kind}:${item.title}`)).toEqual(["isolated_page:Lonely"]);
  });

  it("lints the wiki, closes fixed findings and keeps dismissed ones closed", async () => {
    const { wiki, page } = await setup();
    await page({ title: "Alpha", content: "See [[beta]] and [[gamma]]." });
    await page({ title: "Beta", content: "Back to [[alpha]]." });
    await page({ title: "Lonely", content: "Nobody links here." });

    const first = await call<WikiLintResult>(`${wiki}/review/lint`, "POST");
    expect(first.body).toEqual({ opened: 4, closed: 0 });
    const open = (await call<WikiReviewItem[]>(`${wiki}/review?status=open`)).body;
    expect(open.map((item) => `${item.kind}:${item.title}`).sort()).toEqual([
      "broken_link:gamma",
      "isolated_page:Alpha",
      "isolated_page:Beta",
      "isolated_page:Lonely",
    ]);
    expect(open.find((item) => item.kind === "broken_link")).toMatchObject({
      slugs: ["alpha"],
      suggestedSlug: "gamma",
    });

    const lonely = open.find((item) => item.title === "Lonely");
    const dismissed = await call<WikiReviewItem>(`${wiki}/review/${lonely?.id}`, "PATCH", {
      status: "dismissed",
    });
    expect(dismissed.body).toMatchObject({ status: "dismissed", resolvedBy: "Administrator" });

    await page({ title: "Gamma", content: "Linked from [[alpha]]." });
    const second = await call<WikiLintResult>(`${wiki}/review/lint`, "POST");
    // Gamma exists now, and Alpha links both Beta and Gamma, which become related through
    // their common neighbor: nothing is isolated any more.
    expect(second.body).toEqual({ opened: 0, closed: 3 });
    const overview = await call<WikiOverview>(wiki);
    expect(overview.body.openReviews).toBe(0);
    const all = (await call<WikiReviewItem[]>(`${wiki}/review`)).body;
    expect(all.find((item) => item.title === "Lonely")?.status).toBe("dismissed");
  });

  it("lets colleagues raise questions and gives them the purpose of the wiki", async () => {
    const { colleague, wiki } = await setup();
    const purpose = await call(`${wiki}/purpose`, "PUT", {
      purpose: "IT support for 50 people across two sites.",
    });
    expect(purpose.res.status).toBe(200);
    expect((await call<WikiOverview>(wiki)).body.purpose).toBe(
      "IT support for 50 people across two sites.",
    );

    script = [
      [
        {
          type: "tool_calls",
          calls: [
            {
              id: "flag",
              name: "wiki_flag",
              input: {
                kind: "contradiction",
                title: "VPN port differs",
                detail: "[[vpn]] says 51820, the user says 51821.",
                slugs: ["vpn"],
              },
            },
          ],
        },
      ],
      [{ type: "text", text: "I raised it for review." }],
    ];
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    const res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "The VPN port is 51821 now" }, adminCookie),
    );
    // The answer streams: the tools run while the response is read.
    await res.text();
    expect(requests[0]?.system).toContain("IT support for 50 people across two sites.");
    expect(requests[0]?.system).toContain("raise it with wiki_flag");

    const items = (await call<WikiReviewItem[]>(`${wiki}/review`)).body;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "contradiction",
        title: "VPN port differs",
        raisedBy: "Helpdesk",
        slugs: ["vpn"],
      }),
    ]);
  });

  it("deletes a document with the pages written only from it", async () => {
    const { office, colleague, wiki, page } = await setup();
    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append("files", new File(["# Network\n\nCore switch and router."], "network.md"));
    const upload = await app.request(`/api${wiki}/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });
    const [source] = ((await upload.json()) as WikiSourceUploadResult).accepted;

    await page({ title: "Switch", content: "Core switch.", sources: ["Document: network.md"] });
    await page({
      title: "Router",
      content: "Edge router.",
      sources: ["Document: network.md", "Site survey"],
    });
    await page({ title: "Racks", content: "See [[switch]] and [[router|the router]]." });

    const deleted = await call<WikiSourceDeleteResult>(
      `/offices/${office.id}/wiki/sources/${source?.id}?cascade=true`,
      "DELETE",
    );
    expect(deleted.body.deletedPages).toEqual(["switch"]);
    expect(deleted.body.updatedPages.sort()).toEqual(["racks", "router"]);

    expect((await call(`${wiki}/pages/switch`)).res.status).toBe(404);
    expect((await call<WikiPage>(`${wiki}/pages/router`)).body.sources).toEqual(["Site survey"]);
    const racks = await call<WikiPage>(`${wiki}/pages/racks`);
    expect(racks.body).toMatchObject({
      content: "See Switch and [[router|the router]].",
      revision: 2,
    });
    expect((await call<WikiSource[]>(`${wiki}/sources`)).body).toEqual([]);
  });

  it("saves an answer from a conversation to the wiki once", async () => {
    const { colleague, wiki } = await setup();
    script = [[{ type: "text", text: "Restart the WireGuard service." }]];
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    const res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "The VPN hangs, what do I do?" }, adminCookie),
    );
    parseSse(await res.text());
    const stored = await call<Conversation>(`/conversations/${conversation.body.id}`);
    const answer = stored.body.messages.find((message) => message.role === "assistant");

    const saved = await call<WikiSource>(
      `/conversations/${conversation.body.id}/messages/${answer?.id}/wiki`,
      "POST",
    );
    expect(saved.res.status).toBe(201);
    expect(saved.body).toMatchObject({
      status: "queued",
      format: "markdown",
      colleague: { name: "Helpdesk" },
    });
    expect(saved.body.fileName).toMatch(
      /^conversation-the-vpn-hangs-what-do-i-do-\d{4}-\d{2}-\d{2}\.md$/,
    );

    const again = await call(
      `/conversations/${conversation.body.id}/messages/${answer?.id}/wiki`,
      "POST",
    );
    expect(again.res.status).toBe(409);
    expect((await call<WikiSource[]>(`${wiki}/sources`)).body).toHaveLength(1);
  });
});
