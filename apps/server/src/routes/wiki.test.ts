import type {
  ApiError,
  Conversation,
  ConversationSummary,
  ModelProfile,
  ModelProvider,
  Office,
  WikiImportResult,
  WikiLogEntry,
  WikiOverview,
  WikiPage,
  WikiRevision,
  WikiRevisionSummary,
  WikiSearchResult,
  WikiSearchSettings,
} from "@orlok/shared";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { messages, officeMembers } from "../db/schema";
import type { ChatRequest, LlmClientFactory } from "../llm";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];
// What the model replies when asked to write the wiki search.
let searchReply = '{"query": ""}';

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push(request);
    if (request.system?.startsWith("You write the search query")) {
      yield { type: "text", text: searchReply };
      yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text", text: "See [[vpn-access]]." };
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function createOffice(name = "IT Services") {
  return (await call<Office>("/admin/offices", "POST", { name })).body;
}

async function createPage(officeId: string, body: Record<string, unknown>, cookie = adminCookie) {
  return call<WikiPage>(`/offices/${officeId}/wiki/pages`, "POST", body, cookie);
}

describe("office wiki", () => {
  it("creates, reads and lists pages with links and backlinks", async () => {
    const office = await createOffice();
    const created = await createPage(office.id, {
      title: "VPN access",
      section: "Network",
      type: "procedure",
      sources: ["ticket 42"],
      content: "Uses the [[pfSense firewall|firewall]].",
    });
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "vpn-access",
      revision: 1,
      section: "Network",
      type: "procedure",
      sources: ["ticket 42"],
      updatedBy: { kind: "person", name: "Administrator" },
    });

    await createPage(office.id, { title: "pfSense firewall", content: "Firewall of the company." });
    const firewall = await call<WikiPage>(`/offices/${office.id}/wiki/pages/pfsense-firewall`);
    expect(firewall.body.backlinks).toEqual([{ slug: "vpn-access", title: "VPN access" }]);

    const overview = await call<WikiOverview>(`/offices/${office.id}/wiki`);
    expect(overview.body.canEdit).toBe(true);
    expect(overview.body.pages.map((page) => page.slug)).toEqual([
      "pfsense-firewall",
      "vpn-access",
    ]);

    const duplicate = await createPage(office.id, { title: "VPN Access" });
    expect(duplicate.res.status).toBe(409);
    expect((duplicate.body as unknown as ApiError).issues).toEqual([
      { path: "slug", code: "slug_taken" },
    ]);

    const invalid = await createPage(office.id, { title: "X", slug: "Not A Slug" });
    expect(invalid.res.status).toBe(400);
  });

  it("keeps every revision, detects conflicts and restores old versions", async () => {
    const office = await createOffice();
    await createPage(office.id, { title: "Backup", content: "Version one" });
    const path = `/offices/${office.id}/wiki/pages/backup`;

    const updated = await call<WikiPage>(path, "PATCH", {
      baseRevision: 1,
      content: "Version two",
      summary: "Second run",
    });
    expect(updated.body).toMatchObject({ revision: 2, content: "Version two" });

    const stale = await call<ApiError>(path, "PATCH", { baseRevision: 1, content: "Lost" });
    expect(stale.res.status).toBe(409);
    expect(stale.body.code).toBe("revision_conflict");

    const revisions = await call<WikiRevisionSummary[]>(`${path}/revisions`);
    expect(revisions.body.map((item) => [item.revision, item.summary])).toEqual([
      [2, "Second run"],
      [1, null],
    ]);
    const first = await call<WikiRevision>(`${path}/revisions/1`);
    expect(first.body.content).toBe("Version one");

    const restored = await call<WikiPage>(`${path}/revisions/1/restore`, "POST");
    expect(restored.body).toMatchObject({ revision: 3, content: "Version one" });

    expect((await call(path, "DELETE")).res.status).toBe(204);
    expect((await call(path)).res.status).toBe(404);

    const log = await call<WikiLogEntry[]>(`/offices/${office.id}/wiki/log`);
    expect(log.body.map((entry) => entry.action)).toEqual([
      "delete",
      "restore",
      "update",
      "create",
    ]);
  });

  it("lets office members read, managers edit and nobody else see the wiki", async () => {
    const office = await createOffice();
    const other = await createOffice("Accounting");
    await createPage(office.id, { title: "Printers", content: "Floor 2 printer" });

    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const manager = await createMember(deps.db, "manager@example.com");
    await deps.db
      .insert(officeMembers)
      .values({ officeId: office.id, userId: manager.id, role: "manager" });
    const outsider = await createMember(deps.db, "outsider@example.com", [other.id]);

    const memberView = await call<WikiOverview>(
      `/offices/${office.id}/wiki`,
      "GET",
      undefined,
      member.cookie,
    );
    expect(memberView.body.canEdit).toBe(false);
    expect((await createPage(office.id, { title: "Nope" }, member.cookie)).res.status).toBe(403);

    expect((await createPage(office.id, { title: "Scanners" }, manager.cookie)).res.status).toBe(
      201,
    );

    for (const path of ["", "/pages/printers", "/search?q=printer", "/log"]) {
      const res = await call(
        `/offices/${office.id}/wiki${path}`,
        "GET",
        undefined,
        outsider.cookie,
      );
      expect(res.res.status).toBe(404);
    }
  });

  it("searches only inside the office, across word forms and accents", async () => {
    const office = await createOffice();
    const other = await createOffice("Accounting");
    await createPage(office.id, {
      title: "Stampante piano 2",
      content: "Perché la stampante non stampa: controllare il toner.",
    });
    await createPage(office.id, { title: "VPN", content: "WireGuard tunnel" });
    await createPage(other.id, { title: "Stampanti contabilità", content: "Stampante fatture" });

    const results = await call<WikiSearchResult[]>(
      `/offices/${office.id}/wiki/search?q=${encodeURIComponent("le stampanti perche")}`,
    );
    expect(results.body.map((item) => item.slug)).toEqual(["stampante-piano-2"]);
    expect(results.body[0]?.snippet).toContain("toner");

    const none = await call<WikiSearchResult[]>(`/offices/${office.id}/wiki/search?q=the`);
    expect(none.body).toEqual([]);
  });

  it("imports a Markdown folder with sections, frontmatter and links", async () => {
    const office = await createOffice();
    const files = [
      {
        path: "Export/Network/VPN.md",
        content:
          "---\ntitle: VPN access\ntype: procedure\n---\n# VPN access\n\nSee [the firewall](pfSense%20firewall.md).",
      },
      { path: "Export/Network/pfSense firewall.md", content: "Rules and [VPN](./VPN.md)." },
      { path: "Export/Readme.md", content: "Start here" },
      { path: "Export/_resources/image.png", content: "binary" },
    ];

    const first = await call<WikiImportResult>(`/offices/${office.id}/wiki/import`, "POST", {
      files,
    });
    expect(first.body).toEqual({ created: 3, updated: 0, unchanged: 0, secretsRemoved: 0 });

    const vpn = await call<WikiPage>(`/offices/${office.id}/wiki/pages/vpn-access`);
    expect(vpn.body).toMatchObject({
      section: "Network",
      type: "procedure",
      sources: ["Network/VPN.md"],
      content: "See [[pfsense-firewall|the firewall]].",
    });
    const firewall = await call<WikiPage>(`/offices/${office.id}/wiki/pages/pfsense-firewall`);
    expect(firewall.body.content).toBe("Rules and [[vpn-access|VPN]].");
    expect(firewall.body.backlinks).toEqual([{ slug: "vpn-access", title: "VPN access" }]);
    const readme = await call<WikiPage>(`/offices/${office.id}/wiki/pages/readme`);
    expect(readme.body.section).toBeNull();

    const changed = files.map((file) =>
      file.path.endsWith("Readme.md") ? { ...file, content: "Start here, updated" } : file,
    );
    const second = await call<WikiImportResult>(`/offices/${office.id}/wiki/import`, "POST", {
      files: changed,
    });
    expect(second.body).toEqual({ created: 0, updated: 1, unchanged: 2, secretsRemoved: 0 });
  });

  async function helpdeskWithPages() {
    const provider = await call<ModelProvider>("/admin/providers", "POST", {
      name: "Provider",
      kind: "anthropic",
      apiKey: "x",
    });
    const profile = await call<ModelProfile>("/admin/profiles", "POST", {
      name: "Profile",
      providerId: provider.body.id,
      model: "model",
      mode: "ask",
    });
    const office = await createOffice();
    const colleague = await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      name: "Helpdesk",
      profileId: profile.body.id,
    });
    await createPage(office.id, { title: "VPN access", content: "Use the WireGuard client." });
    await createPage(office.id, { title: "Printers", content: "Floor 2 printer" });
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.body.id,
    });
    return conversation.body;
  }

  async function ask(conversationId: string, content: string) {
    const res = await app.request(
      `/api/conversations/${conversationId}/messages`,
      jsonRequest("POST", { content }, adminCookie),
    );
    return parseSse(await res.text());
  }

  it("gives colleagues the relevant pages and records them on the answer", async () => {
    const conversation = { body: await helpdeskWithPages() };
    const res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "The VPN does not connect" }, adminCookie),
    );
    const events = parseSse(await res.text());
    expect(events[0]).toEqual({
      type: "context",
      pages: [{ slug: "vpn-access", title: "VPN access" }],
    });

    const system = requests.at(-1)?.system ?? "";
    expect(system).toContain("- [[printers]] Printers");
    expect(system).toContain(
      '<page slug="vpn-access" title="VPN access">\nUse the WireGuard client.',
    );
    expect(system).not.toContain("Floor 2 printer");

    const stored = await call<Conversation>(`/conversations/${conversation.body.id}`);
    expect(stored.body.messages.map((message) => message.wikiPages)).toEqual([
      [],
      [{ slug: "vpn-access", title: "VPN access" }],
    ]);
  });

  it("searches what a model writes from the conversation, and nothing for small talk", async () => {
    const conversation = await helpdeskWithPages();
    const saved = await call<WikiSearchSettings>("/admin/wiki-search", "PUT", {
      queryRewrite: true,
      queryProfileId: null,
    });
    expect(saved.body).toEqual({ queryRewrite: true, queryProfileId: null });

    // The message names nothing: the search comes from the conversation, written by the model.
    searchReply = '{"query": "VPN WireGuard"}';
    let events = await ask(conversation.id, "still not working, check again");
    expect(events[0]).toEqual({
      type: "context",
      pages: [{ slug: "vpn-access", title: "VPN access" }],
    });
    const asked = requests.find((request) =>
      request.system?.startsWith("You write the search query"),
    );
    const prompt = asked?.messages[0];
    expect(prompt?.role === "user" ? prompt.content : "").toContain(
      "<latest_message>still not working, check again</latest_message>",
    );

    // Small talk: no page at all.
    searchReply = '{"query": ""}';
    events = await ask(conversation.id, "thanks");
    expect(events.some((event) => event.type === "context")).toBe(false);

    // A reply that is not a search: the message is searched as written.
    searchReply = "I cannot help with that.";
    events = await ask(conversation.id, "Printers on floor 2");
    expect(events[0]).toEqual({
      type: "context",
      pages: [{ slug: "printers", title: "Printers" }],
    });

    // Under the answer, the pages it used: the one it cites, not the one it was given.
    const stored = await call<Conversation>(`/conversations/${conversation.id}`);
    expect(stored.body.messages.at(-1)?.wikiPages).toEqual([
      { slug: "vpn-access", title: "VPN access" },
    ]);
    const [given] = await deps.db
      .select({ wikiGiven: messages.wikiGiven })
      .from(messages)
      .where(eq(messages.role, "assistant"))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(given?.wikiGiven).toEqual([{ slug: "printers", title: "Printers" }]);

    const refused = await call<ApiError>("/admin/wiki-search", "PUT", {
      queryRewrite: true,
      queryProfileId: "00000000-0000-4000-8000-000000000000",
    });
    expect(refused.res.status).toBe(400);
  });
});
