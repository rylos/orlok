import { createCanvas } from "@napi-rs/canvas";
import type {
  ChatAttachment,
  Conversation,
  ConversationSummary,
  ModelProvider,
  Office,
} from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { ChatRequest, LlmClientFactory } from "../llm";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push(request);
    yield { type: "text", text: "Seen" };
    yield { type: "done", stopReason: "end_turn", usage: null };
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
  return { office, colleague };
}

async function upload(colleagueId: string, file: File, cookie = adminCookie) {
  const form = new FormData();
  form.append("colleagueId", colleagueId);
  form.append("file", file);
  const res = await app.request("/api/attachments", {
    method: "POST",
    body: form,
    headers: { Cookie: cookie, Origin: "http://localhost" },
  });
  return { res, body: (await res.json()) as ChatAttachment & { code?: string } };
}

function pngFile(name: string, width = 40, height = 30) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3366ff";
  context.fillRect(0, 0, width, height);
  return new File([new Uint8Array(canvas.toBuffer("image/png"))], name, { type: "image/png" });
}

describe("chat attachments", () => {
  it("sends images and document text to the colleague and lists them in the conversation", async () => {
    const { colleague } = await setup();
    const image = await upload(colleague.id, pngFile("screenshot.png"));
    expect(image.res.status).toBe(201);
    expect(image.body).toMatchObject({ kind: "image", mimeType: "image/png", truncated: false });

    const doc = await upload(
      colleague.id,
      new File(["Backup runs every night at 02:00 on srvbak."], "backup notes.txt", {
        type: "text/plain",
      }),
    );
    expect(doc.res.status).toBe(201);
    expect(doc.body).toMatchObject({ kind: "document", fileName: "backup notes.txt" });

    const conversation = (
      await call<ConversationSummary>("/conversations", "POST", { colleagueId: colleague.id })
    ).body;
    const res = await app.request(
      `/api/conversations/${conversation.id}/messages`,
      jsonRequest(
        "POST",
        { content: "", attachmentIds: [image.body.id, doc.body.id] },
        adminCookie,
      ),
    );
    expect(res.status).toBe(200);
    parseSse(await res.text());

    const last = requests[0]?.messages.at(-1);
    expect(last?.role).toBe("user");
    const parts = last?.role === "user" && Array.isArray(last.content) ? last.content : [];
    expect(parts.some((part) => part.type === "image" && part.mimeType === "image/png")).toBe(true);
    expect(
      parts.some((part) => part.type === "text" && part.text.includes("every night at 02:00")),
    ).toBe(true);

    const stored = await call<Conversation>(`/conversations/${conversation.id}`);
    expect(stored.body.title).toBe("screenshot.png, backup notes.txt");
    expect(stored.body.messages[0]?.attachments.map((item) => item.fileName)).toEqual([
      "screenshot.png",
      "backup notes.txt",
    ]);

    const file = await app.request(`/api/attachments/${image.body.id}`, {
      headers: { Cookie: adminCookie },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const download = await app.request(`/api/attachments/${doc.body.id}`, {
      headers: { Cookie: adminCookie },
    });
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");

    // Sent attachments cannot be reused or removed.
    const again = await app.request(
      `/api/conversations/${conversation.id}/messages`,
      jsonRequest("POST", { content: "Again", attachmentIds: [image.body.id] }, adminCookie),
    );
    expect(again.status).toBe(404);
    expect((await call(`/attachments/${image.body.id}`, "DELETE")).res.status).toBe(409);
  });

  it("rejects unsupported files and keeps attachments private", async () => {
    const { office, colleague } = await setup();
    const exe = await upload(colleague.id, new File(["MZ"], "setup.exe"));
    expect(exe.res.status).toBe(422);
    expect(exe.body.code).toBe("unsupported_file");
    const fake = await upload(colleague.id, new File(["not an image"], "photo.png"));
    expect(fake.res.status).toBe(422);
    expect(fake.body.code).toBe("file_unreadable");

    const image = await upload(colleague.id, pngFile("mine.png"));
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const res = await app.request(`/api/attachments/${image.body.id}`, {
      headers: { Cookie: member.cookie },
    });
    expect(res.status).toBe(404);

    // Unsent attachments can be removed by their owner.
    expect((await call(`/attachments/${image.body.id}`, "DELETE")).res.status).toBe(204);
  });

  it("scales large images down", async () => {
    const { colleague } = await setup();
    const big = await upload(colleague.id, pngFile("wide.png", 4_000, 1_000));
    expect(big.res.status).toBe(201);
    expect(big.body.mimeType).toBe("image/jpeg");
  });
});
