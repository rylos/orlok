import type {
  ApiError,
  Conversation,
  ConversationSummary,
  ModelProvider,
  Office,
} from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { LlmClientFactory } from "../llm";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

// What happened in use on 21/09/2026: two answers writing the wiki, stopped halfway at the
// same instant because the browser closed their connections. An answer now belongs to the
// server: the page only watches it (R-CHAT-13).

const deps = createTestDeps();

// The model writes a first sentence, then waits here until the test lets it finish, the way a
// real model pauses on a long tool call.
let release: () => void = () => {};
let paused = Promise.resolve();
function holdTheModel() {
  paused = new Promise<void>((resolve) => {
    release = resolve;
  });
}

// How a provider ends a stream that was stopped: Anthropic's SDK throws, OpenAI's just ends.
let endsQuietlyOnAbort = false;
// A provider that streams tool calls says which one it has begun before the call is complete.
let startsATool = false;

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    yield { type: "text", text: "Inizio. " };
    if (startsATool) {
      yield { type: "tool_start", name: "wiki_write" };
    }
    const stopped = await new Promise<boolean>((resolve, reject) => {
      const abort = () =>
        endsQuietlyOnAbort
          ? resolve(true)
          : reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (request.signal?.aborted) {
        abort();
      }
      request.signal?.addEventListener("abort", abort);
      void paused.then(() => resolve(false));
    });
    if (stopped) {
      return;
    }
    yield { type: "text", text: "Fine." };
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  holdTheModel();
  endsQuietlyOnAbort = false;
  startsATool = false;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function startConversation() {
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
      instructions: "Sii breve.",
    })
  ).body;
  return (await call<ConversationSummary>("/conversations", "POST", { colleagueId: colleague.id }))
    .body.id;
}

function ask(id: string, content: string) {
  return app.request(
    `/api/conversations/${id}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
}

// Reads the stream until the first sentence arrives, then goes away like a closed tab.
async function readFirstThenLeave(res: Response) {
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  while (reader && !seen.includes("Inizio")) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    seen += value;
  }
  await reader?.cancel();
  return seen;
}

async function conversation(id: string) {
  return (await call<Conversation>(`/conversations/${id}`)).body;
}

async function untilFinished(id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await conversation(id)).running) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The answer never finished");
}

describe("an answer that belongs to the server", () => {
  it("keeps being written after the page that asked is closed", async () => {
    const id = await startConversation();
    expect(await readFirstThenLeave(await ask(id, "Scrivi la pagina."))).toContain("Inizio");
    expect((await conversation(id)).running).toBe(true);

    release();
    await untilFinished(id);
    expect((await conversation(id)).messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Inizio. Fine.",
      status: "complete",
    });
  });

  it("lets a page opened later follow the answer from its beginning", async () => {
    const id = await startConversation();
    await readFirstThenLeave(await ask(id, "Scrivi la pagina."));

    const reopened = await app.request(`/api/conversations/${id}/stream`, {
      headers: { Cookie: adminCookie },
    });
    expect(reopened.status).toBe(200);
    release();
    const events = parseSse(await reopened.text());
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Inizio. Fine.");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("says there is nothing to follow when the colleague is not answering", async () => {
    const id = await startConversation();
    const res = await app.request(`/api/conversations/${id}/stream`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(204);
  });

  it("refuses a second message while the first answer is written, and takes it after", async () => {
    const id = await startConversation();
    await readFirstThenLeave(await ask(id, "Scrivi la pagina."));

    // From another tab, which did not know the colleague was still at work.
    const second = await ask(id, "Hai fatto?");
    expect(second.status).toBe(409);
    expect(((await second.json()) as ApiError).code).toBe("turn_in_progress");

    release();
    await untilFinished(id);
    // The refused message was not stored.
    expect((await conversation(id)).messages.map((message) => message.content)).toEqual([
      "Scrivi la pagina.",
      "Inizio. Fine.",
    ]);

    const after = await ask(id, "Hai fatto?");
    expect(after.status).toBe(200);
    await after.text();
  });

  it("records a stopped answer as stopped even when the provider ends the stream quietly", async () => {
    // Seen with an OpenAI-compatible provider: the half answer was stored as complete.
    endsQuietlyOnAbort = true;
    const id = await startConversation();
    await readFirstThenLeave(await ask(id, "Scrivi la pagina."));

    await app.request(`/api/conversations/${id}/stop`, jsonRequest("POST", undefined, adminCookie));
    await untilFinished(id);
    expect((await conversation(id)).messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Inizio. ",
      status: "stopped",
    });
  });

  it("says which tool the colleague has begun while it is still being written", async () => {
    // A whole wiki page is written as the input of one call: minutes without a word otherwise.
    startsATool = true;
    const id = await startConversation();
    const res = await ask(id, "Scrivi la pagina.");
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    while (reader && !seen.includes('"tool"')) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      seen += value;
    }
    // Seen before the model finished: the model is still held.
    expect(parseSse(seen)).toContainEqual({ type: "tool", name: "wiki_write" });
    release();
    await reader?.cancel();
    await untilFinished(id);
  });

  it("ends early only when someone presses Stop", async () => {
    const id = await startConversation();
    await readFirstThenLeave(await ask(id, "Scrivi la pagina."));

    const stopped = await app.request(
      `/api/conversations/${id}/stop`,
      jsonRequest("POST", undefined, adminCookie),
    );
    expect(stopped.status).toBe(204);
    await untilFinished(id);
    expect((await conversation(id)).messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "stopped",
    });
  });
});
