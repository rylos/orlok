import type {
  ApiError,
  Conversation,
  ConversationSummary,
  ModelProfile,
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

// Fake provider: records requests, fails for the model "broken", otherwise answers "Hello".
const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push(request);
    if (request.model === "broken") {
      throw new Error("503: overloaded");
    }
    yield { type: "text", text: "Hel" };
    yield { type: "text", text: "lo" };
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } };
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

async function createModel(model = "claude-haiku-4-5") {
  const provider = await call<ModelProvider>("/admin/providers", "POST", {
    name: `Provider ${model}`,
    kind: "anthropic",
    apiKey: "x",
  });
  const profile = await call<ModelProfile>("/admin/profiles", "POST", {
    name: `Profile ${model}`,
    providerId: provider.body.id,
    model,
    mode: "ask",
  });
  return profile.body;
}

// The colleague works with the first profile unless the body names one.
async function createOfficeWithColleague(body: Record<string, unknown> = {}) {
  const office = await call<Office>("/admin/offices", "POST", {
    name: "IT Services",
    description: "IT support for the company",
  });
  const [first] = (await call<ModelProfile[]>("/admin/profiles")).body;
  const colleague = await createColleague(app, deps.db, adminCookie, {
    officeId: office.body.id,
    name: "Helpdesk",
    title: "First line support",
    instructions: "Always ask for the PC name.",
    profileId: first?.id,
    ...body,
  });
  return { office: office.body, colleague: colleague.body };
}

async function startConversation(colleagueId: string, cookie = adminCookie) {
  const { res, body } = await call<ConversationSummary>(
    "/conversations",
    "POST",
    { colleagueId },
    cookie,
  );
  expect(res.status).toBe(201);
  return body;
}

async function sendMessage(conversationId: string, content: string, cookie = adminCookie) {
  const res = await app.request(
    `/api/conversations/${conversationId}/messages`,
    jsonRequest("POST", { content }, cookie),
  );
  return { res, events: res.ok ? parseSse(await res.text()) : [] };
}

describe("conversations", () => {
  it("streams the answer and stores both messages with a title", async () => {
    await createModel();
    const { colleague } = await createOfficeWithColleague();
    const conversation = await startConversation(colleague.id);

    const { events } = await sendMessage(conversation.id, "The printer on floor 2\ndoes not print");
    expect(events.map((event) => (event.type === "text" ? event.text : event.type))).toEqual([
      "Hel",
      "lo",
      "done",
    ]);

    const stored = await call<Conversation>(`/conversations/${conversation.id}`);
    expect(stored.body.title).toBe("The printer on floor 2");
    expect(stored.body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "The printer on floor 2\ndoes not print" }),
      expect.objectContaining({
        role: "assistant",
        content: "Hello",
        status: "complete",
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    ]);
  });

  it("builds the colleague's system prompt and sends the history", async () => {
    await createModel();
    const { colleague } = await createOfficeWithColleague();
    const conversation = await startConversation(colleague.id);

    await sendMessage(conversation.id, "First question");
    await sendMessage(conversation.id, "Second question");

    const last = requests.at(-1);
    expect(last?.system).toContain("You are Helpdesk, First line support");
    expect(last?.system).toContain("IT Services office of Test Company");
    expect(last?.system).toContain("You are talking with Administrator");
    expect(last?.system).toContain("<instructions>\nAlways ask for the PC name.\n</instructions>");
    expect(last?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Second question" },
    ]);
  });

  it("answers with each colleague's own profile", async () => {
    const first = await createModel("first-model");
    const second = await createModel("second-model");
    const { office, colleague } = await createOfficeWithColleague({ profileId: first.id });
    const other = await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      name: "DBA",
      profileId: second.id,
    });

    await sendMessage((await startConversation(colleague.id)).id, "Hi");
    await sendMessage((await startConversation(other.body.id)).id, "Hi");
    expect(requests.map((request) => request.model)).toEqual(["first-model", "second-model"]);
  });

  it("refuses a colleague without a profile, and one whose provider is off", async () => {
    const office = await call<Office>("/admin/offices", "POST", { name: "IT Services" });
    const missing = await createColleague(app, deps.db, adminCookie, {
      officeId: office.body.id,
      name: "Helpdesk",
    });
    expect(missing.res.status).toBe(400);
    expect((missing.body as unknown as ApiError).issues).toEqual([
      { path: "profileId", code: "required" },
    ]);

    const profile = await createModel();
    const colleague = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.body.id,
        name: "Helpdesk",
        profileId: profile.id,
      })
    ).body;
    await call(`/admin/providers/${profile.providerId}`, "PATCH", { enabled: false });
    const conversation = await startConversation(colleague.id);

    const { res } = await sendMessage(conversation.id, "Hi");
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).code).toBe("model_not_configured");
    expect((await call<Conversation>(`/conversations/${conversation.id}`)).body.messages).toEqual(
      [],
    );
  });

  it("stores failed answers and leaves them out of the next request", async () => {
    const broken = await createModel("broken");
    const { colleague } = await createOfficeWithColleague({ profileId: broken.id });
    const conversation = await startConversation(colleague.id);

    const { events } = await sendMessage(conversation.id, "Hi");
    expect(events).toEqual([{ type: "error", code: "provider_error", message: "503: overloaded" }]);

    const stored = await call<Conversation>(`/conversations/${conversation.id}`);
    expect(stored.body.messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "error",
      errorCode: "provider_error",
    });

    await sendMessage(conversation.id, "Retry");
    expect(requests.at(-1)?.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "user", content: "Retry" },
    ]);
  });

  it("keeps conversations private and bound to office access", async () => {
    const profile = await createModel();
    const { office, colleague } = await createOfficeWithColleague();
    const adminConversation = await startConversation(colleague.id);

    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const outsider = await createMember(deps.db, "outsider@example.com");

    const foreign = await call(
      `/conversations/${adminConversation.id}`,
      "GET",
      undefined,
      member.cookie,
    );
    expect(foreign.res.status).toBe(404);
    // Colleagues are personal: the administrator's is not there for the member (R-ADM-3).
    const notTheirs = await call(
      "/conversations",
      "POST",
      { colleagueId: colleague.id },
      member.cookie,
    );
    expect(notTheirs.res.status).toBe(404);

    const own = (
      await createColleague(app, deps.db, member.cookie, {
        officeId: office.id,
        name: "Helpdesk",
        profileId: profile.id,
      })
    ).body;
    const memberConversation = await startConversation(own.id, member.cookie);
    const list = await call<ConversationSummary[]>(
      `/conversations?colleagueId=${own.id}`,
      "GET",
      undefined,
      member.cookie,
    );
    expect(list.body.map((item) => item.id)).toEqual([memberConversation.id]);

    const blocked = await call("/conversations", "POST", { colleagueId: own.id }, outsider.cookie);
    expect(blocked.res.status).toBe(404);

    const { events } = await sendMessage(memberConversation.id, "Ciao", member.cookie);
    expect(events.at(-1)?.type).toBe("done");
    expect(requests.at(-1)?.system).toContain("if it is unclear, use Italiano");

    // Out of the office, the colleague and its conversations are out of reach too.
    await call(`/admin/people/${member.id}`, "PATCH", { memberships: [] });
    const gone = await call(
      `/conversations/${memberConversation.id}`,
      "GET",
      undefined,
      member.cookie,
    );
    expect(gone.res.status).toBe(404);
  });

  it("renames and deletes a conversation", async () => {
    await createModel();
    const { colleague } = await createOfficeWithColleague();
    const conversation = await startConversation(colleague.id);
    // Other pages of the same person follow along on /me/events.
    const events = await app.request("/api/me/events", jsonRequest("GET", undefined, adminCookie));
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body?.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const until = async (text: string) => {
      while (reader && !received.includes(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
      return received.includes(text);
    };
    expect(await until("event: ready")).toBe(true);

    const renamed = await call<ConversationSummary>(`/conversations/${conversation.id}`, "PATCH", {
      title: "VPN issue",
    });
    expect(renamed.body.title).toBe("VPN issue");

    expect((await call(`/conversations/${conversation.id}`, "DELETE")).res.status).toBe(204);
    expect((await call(`/conversations/${conversation.id}`)).res.status).toBe(404);
    expect(await until('"deleted":true')).toBe(true);
    expect(received).toContain(`"conversationId":"${conversation.id}"`);
    await reader?.cancel();
  });
});
