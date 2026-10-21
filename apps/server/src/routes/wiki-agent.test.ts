import { createCanvas } from "@napi-rs/canvas";
import type {
  Conversation,
  ConversationSummary,
  ModelProfile,
  ModelProvider,
  Office,
  WikiLogEntry,
  WikiPage,
  WikiReviewItem,
  WikiRevisionSummary,
  WikiSource,
  WikiSourceUploadResult,
} from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { processNextWikiSource } from "../services/wiki-ingest";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];
// Chunks of the next model calls, one entry per call; a plain answer when empty.
let script: ChatChunk[][] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    // The tool loop keeps appending to the same array: record a copy.
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

async function createOfficeWithColleague() {
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
      instructions: "Be brief.",
    })
  ).body;
  return { office, colleague };
}

function toolCall(name: string, input: unknown, id = `call-${name}`): ChatChunk {
  return { type: "tool_calls", calls: [{ id, name, input }] };
}

async function chat(colleagueId: string, content: string) {
  const conversation = await call<ConversationSummary>("/conversations", "POST", { colleagueId });
  const res = await app.request(
    `/api/conversations/${conversation.body.id}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
  return { id: conversation.body.id, events: parseSse(await res.text()) };
}

describe("virtual colleagues and the wiki", () => {
  it("lets a colleague save what it learns in a conversation", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    script = [
      [
        { type: "text", text: "Noted." },
        toolCall("wiki_write", {
          title: "VPN client",
          section: "Network",
          type: "procedure",
          content: "Restart the WireGuard service.",
        }),
      ],
      [{ type: "text", text: "I saved it in [[vpn-client]]." }],
    ];

    const { id, events } = await chat(colleague.id, "When the VPN hangs, restart WireGuard.");
    expect(events.map((event) => event.type)).toEqual([
      "text",
      "tool",
      "wiki_edit",
      "text",
      "text",
      "done",
    ]);
    expect(events).toContainEqual({
      type: "wiki_edit",
      edit: { slug: "vpn-client", title: "VPN client", action: "create" },
    });

    const toolResult = requests[1]?.messages.at(-1);
    expect(toolResult).toMatchObject({
      role: "tool",
      results: [{ toolCallId: "call-wiki_write", isError: false }],
    });
    expect(requests[0]?.system).toContain("update the wiki on your own");
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "wiki_search",
      "wiki_read",
      "wiki_write",
      "wiki_edit",
      "wiki_flag",
      "wiki_review_list",
      "wiki_review_close",
      "notes_write",
    ]);

    const page = await call<WikiPage>(`/offices/${office.id}/wiki/pages/vpn-client`);
    expect(page.body).toMatchObject({
      section: "Network",
      type: "procedure",
      updatedBy: { kind: "colleague", name: "Helpdesk" },
    });
    expect(page.body.sources[0]).toMatch(/^Conversation with Administrator, \d{4}-\d{2}-\d{2}$/);
    // The revision says which conversation it came from (R-MEM-3).
    const revisions = await call<WikiRevisionSummary[]>(
      `/offices/${office.id}/wiki/pages/vpn-client/revisions`,
    );
    expect(revisions.body[0]?.origin).toEqual({ conversationId: expect.any(String) });

    const stored = await call<Conversation>(`/conversations/${id}`);
    expect(stored.body.messages.at(-1)).toMatchObject({
      content: "Noted.\n\nI saved it in [[vpn-client]].",
      wikiEdits: [{ slug: "vpn-client", title: "VPN client", action: "create" }],
    });
  });

  // A member who may not edit the wiki gets proposals from their colleague: nothing is written
  // until an office manager applies it, on the revision it was made on (R-MEM-3).
  it("proposes instead of writing for someone who cannot edit the wiki", async () => {
    const { office } = await createOfficeWithColleague();
    const profileId = (await call<{ id: string }[]>("/admin/profiles")).body[0]?.id ?? "";
    const member = await createMember(deps.db, "mario@example.com", [office.id]);
    const colleague = (
      await createColleague(app, deps.db, member.cookie, {
        officeId: office.id,
        profileId,
        name: "Aiuto",
      })
    ).body;
    script = [
      [toolCall("wiki_write", { title: "Stampante piano terra", content: "IP 10.0.0.76." })],
      [{ type: "text", text: "Proposto." }],
    ];
    const created = await app.request(
      "/api/conversations",
      jsonRequest("POST", { colleagueId: colleague.id }, member.cookie),
    );
    const { id } = (await created.json()) as ConversationSummary;
    const sent = await app.request(
      `/api/conversations/${id}/messages`,
      jsonRequest("POST", { content: "Segnati la stampante" }, member.cookie),
    );
    await sent.text();

    const toolResult = requests[1]?.messages.at(-1);
    expect(toolResult?.role === "tool" ? toolResult.results[0]?.content : "").toContain(
      "proposed to the office managers",
    );
    const missing = await call(`/offices/${office.id}/wiki/pages/stampante-piano-terra`);
    expect(missing.res.status).toBe(404);
    const [item] = (
      await call<WikiReviewItem[]>(`/offices/${office.id}/wiki/review?status=open`)
    ).body.filter((entry) => entry.kind === "proposal");
    expect(item?.proposal).toMatchObject({
      action: "create",
      slug: "stampante-piano-terra",
      baseRevision: null,
      proposedFor: "mario",
      origin: { conversationId: id },
    });

    // The member may not apply it; a manager (here the administrator) may, once.
    const refused = await app.request(
      `/api/offices/${office.id}/wiki/review/${item?.id}/apply`,
      jsonRequest("POST", undefined, member.cookie),
    );
    expect(refused.status).toBe(403);
    expect(
      (await call(`/offices/${office.id}/wiki/review/${item?.id}/apply`, "POST")).res.status,
    ).toBe(204);
    const page = await call<WikiPage>(`/offices/${office.id}/wiki/pages/stampante-piano-terra`);
    expect(page.body).toMatchObject({
      title: "Stampante piano terra",
      content: "IP 10.0.0.76.",
    });
    const again = await call(`/offices/${office.id}/wiki/review/${item?.id}/apply`, "POST");
    expect(again.res.status).toBe(404);
  });

  // Private notes (R-MEM-2): the colleague keeps them, sees them in every conversation with its
  // owner, never with secrets; the owner reads them in the colleague's settings.
  it("keeps private notes about working with its owner", async () => {
    const { colleague } = await createOfficeWithColleague();
    script = [
      [toolCall("notes_write", { content: "Password del NAS: Acme2024!" })],
      [toolCall("notes_write", { content: "Preferisce risposte brevi, in italiano." })],
      [{ type: "text", text: "Annotato." }],
    ];
    await chat(colleague.id, "Rispondimi sempre in breve");
    const refused = requests[1]?.messages.at(-1);
    expect(refused?.role === "tool" ? refused.results[0] : null).toMatchObject({ isError: true });
    const saved = await call<{ notes: string }>(`/colleagues/${colleague.id}`);
    expect(saved.body.notes).toBe("Preferisce risposte brevi, in italiano.");

    requests.length = 0;
    await chat(colleague.id, "Ciao");
    expect(requests[0]?.system).toContain(
      "<private_notes>\nPreferisce risposte brevi, in italiano.\n</private_notes>",
    );
  });

  it("refuses secrets and blind overwrites, and lets the colleague read and retry", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    await call(`/offices/${office.id}/wiki/pages`, "POST", {
      title: "Printers",
      content: "Floor 2",
    });
    script = [
      [toolCall("wiki_write", { title: "NAS", content: "password: hunter2222" }, "a")],
      [toolCall("wiki_write", { slug: "printers", title: "Printers", content: "Gone" }, "b")],
      [toolCall("wiki_read", { slug: "printers" }, "c")],
      [
        toolCall(
          "wiki_write",
          { slug: "printers", title: "Printers", content: "Floor 2 and 3", base_revision: 1 },
          "d",
        ),
      ],
      [{ type: "text", text: "Done." }],
    ];

    await chat(colleague.id, "Printers are on floors 2 and 3; NAS password is hunter2222");
    const results = requests.slice(1).map((request) => {
      const last = request.messages.at(-1);
      return last?.role === "tool" ? last.results[0] : null;
    });
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.content).toContain("a password or key value");
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[1]?.content).toContain("base_revision 1");
    expect(results[2]?.content).toContain("revision: 1\n");
    expect(results[3]).toMatchObject({ isError: false });

    const page = await call<WikiPage>(`/offices/${office.id}/wiki/pages/printers`);
    expect(page.body).toMatchObject({ content: "Floor 2 and 3", revision: 2 });
    expect((await call(`/offices/${office.id}/wiki/pages/nas`)).res.status).toBe(404);
  });

  it("files uploaded documents through the colleague", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append("files", new File(["# Backup\n\nNightly backup to PBS at 23:00."], "backup.md"));
    form.append("files", new File(["MZ"], "tool.exe"));
    const upload = await app.request(`/api/offices/${office.id}/wiki/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as WikiSourceUploadResult;
    expect(uploaded.rejected).toEqual([{ fileName: "tool.exe", reason: "unsupported_format" }]);
    expect(uploaded.accepted).toMatchObject([
      { fileName: "backup.md", status: "queued", colleague: { name: "Helpdesk" } },
    ]);

    script = [
      [{ type: "text", text: "## Summary\nNightly backup schedule." }],
      [
        toolCall("wiki_write", {
          slug: "doc-backup",
          title: "Backup (document)",
          type: "source",
          content: "Summary. See [[backup-schedule]].",
        }),
      ],
      [
        toolCall("wiki_write", {
          title: "Backup schedule",
          content: "Nightly at 23:00 to PBS.",
        }),
      ],
      [{ type: "text", text: "Created two pages." }],
    ];
    expect(await processNextWikiSource(worker)).toBe(true);
    expect(await processNextWikiSource(worker)).toBe(false);

    expect(requests[0]?.system).toContain("part 1 of 1");
    expect(requests[0]?.system).toContain("<instructions>\nBe brief.\n</instructions>");
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Nightly backup to PBS at 23:00."),
    });

    const sources = await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`);
    expect(sources.body[0]).toMatchObject({
      status: "done",
      edits: [
        { slug: "doc-backup", action: "create" },
        { slug: "backup-schedule", action: "create" },
      ],
    });
    const page = await call<WikiPage>(`/offices/${office.id}/wiki/pages/backup-schedule`);
    expect(page.body.sources).toEqual(["Document: backup.md"]);
    const history = await call<WikiRevisionSummary[]>(
      `/offices/${office.id}/wiki/pages/backup-schedule/revisions`,
    );
    expect(history.body[0]?.origin).toEqual({ sourceId: sources.body[0]?.id });
    const log = await call<WikiLogEntry[]>(`/offices/${office.id}/wiki/log`);
    expect(log.body[0]).toMatchObject({
      action: "ingest",
      title: "backup.md",
      detail: "created 2, updated 0",
      author: { kind: "colleague", name: "Helpdesk" },
    });
  });

  // An uploaded document often carries the passwords of whoever wrote it: they are removed before
  // any model reads the text, and the document says how many (R-SEC-3).
  it("removes credentials from an uploaded document before the model reads it", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append(
      "files",
      new File(
        ["# NAS\n\nAccesso admin.\nPassword: Acme2024!\nDB_PASSWORD=Sup3rS3gr3to\n"],
        "nas.md",
      ),
    );
    await app.request(`/api/offices/${office.id}/wiki/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });
    script = [[{ type: "text", text: "## Summary\nNAS access." }]];
    await processNextWikiSource(worker);

    const sent = JSON.stringify(requests);
    expect(sent).not.toContain("Acme2024!");
    expect(sent).not.toContain("Sup3rS3gr3to");
    expect(sent).toContain("[secret removed]");
    const sources = await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`);
    expect(sources.body[0]?.secretsRemoved).toBe(2);
  });

  it("records a failed ingest and lets it be retried", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append("files", new File(["Some notes"], "notes.txt"));
    await app.request(`/api/offices/${office.id}/wiki/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });
    await call(`/colleagues/${colleague.id}`, "PATCH", { archived: true });

    await processNextWikiSource(worker);
    const [failed] = (await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`)).body;
    expect(failed).toMatchObject({
      status: "error",
      error: "The virtual colleague is not available",
    });

    await call(`/colleagues/${colleague.id}`, "PATCH", { archived: false });
    const retried = await call<WikiSource>(
      `/offices/${office.id}/wiki/sources/${failed?.id}/retry`,
      "POST",
    );
    expect(retried.body.status).toBe("queued");
    await processNextWikiSource(worker);
    const [done] = (await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`)).body;
    expect(done?.status).toBe("done");
  });

  it("skips documents already imported and reports unreadable ones", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    async function upload(...files: File[]) {
      const form = new FormData();
      form.append("colleagueId", colleague.id);
      for (const file of files) {
        form.append("files", file);
      }
      const res = await app.request(`/api/offices/${office.id}/wiki/sources`, {
        method: "POST",
        body: form,
        headers: { Cookie: adminCookie, Origin: "http://localhost" },
      });
      return (await res.json()) as WikiSourceUploadResult;
    }

    const first = await upload(new File(["Same text"], "a.txt"), new File(["Same text"], "b.txt"));
    expect(first.accepted.map((item) => item.fileName)).toEqual(["a.txt"]);
    expect(first.rejected).toEqual([{ fileName: "b.txt", reason: "duplicate" }]);
    const again = await upload(new File(["Same text"], "c.txt"));
    expect(again.rejected).toEqual([{ fileName: "c.txt", reason: "duplicate" }]);

    await upload(new File([""], "empty.txt"));
    script = [[{ type: "text", text: "Nothing to file." }]];
    await processNextWikiSource(worker);
    await processNextWikiSource(worker);
    const sources = await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`);
    expect(sources.body.find((item) => item.fileName === "empty.txt")).toMatchObject({
      status: "error",
      errorCode: "no_text",
    });
    expect(sources.body.find((item) => item.fileName === "a.txt")).toMatchObject({
      status: "done",
      errorCode: null,
      ocrUnits: 0,
    });
  });

  it("describes a picture without text with the vision model", async () => {
    const { office, colleague } = await createOfficeWithColleague();
    const [profile] = (await call<ModelProfile[]>("/admin/profiles")).body;
    const saved = await call("/admin/documents", "PUT", { visionProfileId: profile?.id });
    expect(saved.res.status).toBe(200);

    const canvas = createCanvas(320, 240);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 320, 240);
    context.fillStyle = "#3355aa";
    context.fillRect(40, 40, 120, 80);
    const png = canvas.toBuffer("image/png");

    const form = new FormData();
    form.append("colleagueId", colleague.id);
    form.append("files", new File([new Uint8Array(png)], "rack.png", { type: "image/png" }));
    await app.request(`/api/offices/${office.id}/wiki/sources`, {
      method: "POST",
      body: form,
      headers: { Cookie: adminCookie, Origin: "http://localhost" },
    });

    script = [
      [{ type: "text", text: "A blue rectangle on a white background: the rack layout." }],
      [{ type: "text", text: "Nothing worth filing." }],
    ];
    await processNextWikiSource(worker);

    const visionMessage = requests[0]?.messages[0];
    expect(
      visionMessage?.role === "user" && Array.isArray(visionMessage.content)
        ? visionMessage.content[0]?.type
        : null,
    ).toBe("image");
    expect(requests[1]?.messages[0]).toMatchObject({
      content: expect.stringContaining("the rack layout"),
    });
    const [source] = (await call<WikiSource[]>(`/offices/${office.id}/wiki/sources`)).body;
    expect(source).toMatchObject({ status: "done", format: "image", imageCount: 1 });
  }, 60_000);
});
