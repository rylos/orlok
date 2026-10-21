import type { Conversation, ConversationSummary, ModelProvider, Office } from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { messages as messageRows } from "../db/schema";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

// A conversation grows until it no longer fits the model. What must not happen is what happened
// before: the provider refusing the prompt and the conversation staying refused for good.

const deps = createTestDeps();
const requests: ChatRequest[] = [];
// One entry per model call: its chunks, or the failure the provider answers with.
let script: (ChatChunk[] | Error)[] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push({ ...request, messages: [...request.messages] });
    const next = script.shift();
    if (next instanceof Error) {
      throw next;
    }
    for (const chunk of next ?? [{ type: "text", text: "OK" }]) {
      yield chunk;
    }
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } };
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

async function colleagueWithProfile(profile: {
  contextWindow?: number | null;
  maxOutputTokens?: number;
}) {
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
      maxOutputTokens: profile.maxOutputTokens ?? 1_000,
      contextWindow: profile.contextWindow ?? null,
      mode: "ask",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "Servizi IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Helpdesk",
      instructions: "Sii breve.",
    })
  ).body;
  return colleague;
}

// A conversation already long before this turn: written straight into the database, the way it
// would have grown over days of use.
async function withHistory(colleagueId: string, turns: number, size: number) {
  const conversation = await call<ConversationSummary>("/conversations", "POST", { colleagueId });
  const now = Date.now();
  await deps.db.insert(messageRows).values(
    Array.from({ length: turns * 2 }, (_, index) => ({
      conversationId: conversation.body.id,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index % 2 === 0 ? "Domanda" : "Risposta"} ${index}: ${"parola ".repeat(size)}`,
      createdAt: new Date(now - (turns * 2 - index) * 1_000),
    })),
  );
  return conversation.body.id;
}

async function ask(conversationId: string, content: string) {
  const res = await app.request(
    `/api/conversations/${conversationId}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
  return parseSse(await res.text());
}

describe("keeping a conversation inside the model window", () => {
  it("summarizes the oldest messages before the model refuses them", async () => {
    const colleague = await colleagueWithProfile({ contextWindow: 8_000 });
    const id = await withHistory(colleague.id, 12, 300);
    script = [
      [{ type: "text", text: "## Subject\nRiassunto." }],
      [{ type: "text", text: "Ecco." }],
    ];

    const events = await ask(id, "E quindi?");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.some((event) => event.type === "error")).toBe(false);

    // Two calls: the summary, then the answer. The answer no longer carries the oldest messages.
    expect(requests).toHaveLength(2);
    const answered = requests[1]?.messages ?? [];
    expect(JSON.stringify(answered[0])).toContain("conversation_summary");
    expect(JSON.stringify(answered)).not.toContain("Domanda 0");
    expect(JSON.stringify(answered)).toContain("E quindi?");

    const stored = await call<Conversation>(`/conversations/${id}`);
    expect(stored.body.compacted).toBe(true);
    expect(stored.body.contextWindow).toBe(8_000);
    // Nothing was thrown away: the person still reads the whole conversation.
    expect(stored.body.messages).toHaveLength(26);
  });

  it("leaves a conversation that fits alone", async () => {
    const colleague = await colleagueWithProfile({ contextWindow: 200_000 });
    const id = await withHistory(colleague.id, 3, 50);

    await ask(id, "Tutto bene?");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Domanda 0");
    const stored = await call<Conversation>(`/conversations/${id}`);
    expect(stored.body.compacted).toBe(false);
  });

  it("recovers a prompt the provider refuses for its size, and answers", async () => {
    // No window configured: the refusal is the only signal there is.
    const colleague = await colleagueWithProfile({ contextWindow: null });
    const id = await withHistory(colleague.id, 12, 300);
    script = [
      new Error("400 prompt is too long: 213462 tokens > 200000 maximum"),
      [{ type: "text", text: "## Subject\nRiassunto." }],
      [{ type: "text", text: "Ecco la risposta." }],
    ];

    const events = await ask(id, "E quindi?");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Ecco la risposta.");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages[0])).toContain("conversation_summary");

    const stored = await call<Conversation>(`/conversations/${id}`);
    expect(stored.body.messages.at(-1)).toMatchObject({
      content: "Ecco la risposta.",
      status: "complete",
    });
  });

  it("says what is wrong when even summarizing cannot save the turn", async () => {
    const colleague = await colleagueWithProfile({ contextWindow: null });
    // One exchange only: there is nothing older to summarize.
    const id = await withHistory(colleague.id, 1, 10);
    script = [new Error("400 prompt is too long: 213462 tokens > 200000 maximum")];

    const events = await ask(id, "E quindi?");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_overflow" });
    // One call: no summary was attempted where none was possible, and nothing was retried.
    expect(requests).toHaveLength(1);

    const stored = await call<Conversation>(`/conversations/${id}`);
    expect(stored.body.messages.at(-1)).toMatchObject({
      status: "error",
      errorCode: "context_overflow",
    });
  });

  it("does not replay a command to make a prompt smaller", async () => {
    const colleague = await colleagueWithProfile({ contextWindow: null });
    const id = await withHistory(colleague.id, 12, 300);
    script = [
      [
        { type: "text", text: "Guardo." },
        { type: "tool_calls", calls: [{ id: "c1", name: "wiki_search", input: { query: "x" } }] },
      ],
      new Error("400 prompt is too long: 213462 tokens > 200000 maximum"),
    ];

    const events = await ask(id, "Cerca nella wiki.");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_overflow" });
    // The tool ran, so the turn fails instead of being replayed from the start.
    expect(requests).toHaveLength(2);
  });
});
