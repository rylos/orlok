import { describe, expect, it } from "vitest";
import type { ChatRequest, LlmClient } from "../llm";
import { chooseCut, compactHistory, historyAfterSummary, summaryMessage } from "./compaction";

// Summarizing the beginning of a conversation is the last resort before a turn stops fitting.
// What matters is where it cuts and that the messages themselves survive it.

function client(answer = "## Subject\nIl server srvbak.") {
  const requests: ChatRequest[] = [];
  const fake: LlmClient = {
    async listModels() {
      return [];
    },
    async *streamChat(request) {
      requests.push(request);
      yield { type: "text", text: answer };
      yield { type: "done", stopReason: "end_turn", usage: null };
    },
  };
  return { fake, requests };
}

const turns = (count: number, size = 400) =>
  Array.from({ length: count * 2 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${index % 2 === 0 ? "domanda" : "risposta"} ${index} ${"parola ".repeat(size)}`,
  }));

describe("choosing where to cut", () => {
  it("cuts at a question, never between a question and its answer", () => {
    const rows = turns(10);
    const cut = chooseCut(rows, 4_000);
    expect(rows[cut]?.role).toBe("user");
    expect(cut).toBeGreaterThan(0);
  });

  it("keeps the recent tail whole", () => {
    const rows = turns(10);
    const kept = rows.slice(chooseCut(rows, 20_000));
    expect(kept.length).toBeGreaterThan(4);
  });

  it("never summarizes the whole conversation", () => {
    const rows = turns(1);
    expect(chooseCut(rows, 1)).toBeLessThan(rows.length);
  });
});

describe("summarizing the older messages", () => {
  it("replaces them with a summary and keeps the rest", async () => {
    const { fake, requests } = client();
    const rows = turns(12);
    const result = await compactHistory({
      client: fake,
      model: "model",
      maxOutputTokens: 4_000,
      contextWindow: 100_000,
      rows,
      previousSummary: null,
      keepRecentTokens: 4_000,
    });

    expect(result).not.toBeNull();
    expect(result?.summary).toContain("srvbak");
    // The cut is a real message of the conversation, so the next turn can be rebuilt from it.
    expect(rows.some((row) => row.id === result?.throughMessageId)).toBe(true);
    expect(result?.keptRows.length).toBeLessThan(rows.length);
    expect(result?.keptRows.at(-1)).toEqual(rows.at(-1));
    // The summary request carries the older messages and nothing of the kept tail.
    const asked = requests[0]?.messages ?? [];
    expect(asked.length).toBeGreaterThan(2);
    expect(JSON.stringify(asked)).not.toContain(rows.at(-1)?.content);
  });

  it("does nothing when there is too little behind to be worth a model call", async () => {
    const { fake, requests } = client();
    const result = await compactHistory({
      client: fake,
      model: "model",
      maxOutputTokens: 4_000,
      contextWindow: 100_000,
      rows: turns(2, 5),
      previousSummary: null,
    });
    expect(result).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("updates an existing summary instead of starting a new one", async () => {
    const { fake, requests } = client();
    await compactHistory({
      client: fake,
      model: "model",
      maxOutputTokens: 4_000,
      contextWindow: 100_000,
      rows: turns(12),
      previousSummary: "## Subject\nQuanto detto prima.",
      keepRecentTokens: 4_000,
    });
    expect(requests[0]?.system).toContain("Quanto detto prima");
    expect(requests[0]?.system).toContain("previous_summary");
  });

  it("drops its own oldest messages rather than sending a request too large to answer", async () => {
    const { fake, requests } = client();
    const result = await compactHistory({
      client: fake,
      model: "model",
      maxOutputTokens: 1_000,
      // A window far smaller than the conversation: the summary request must still go out.
      contextWindow: 8_000,
      rows: turns(20, 600),
      previousSummary: null,
      keepRecentTokens: 2_000,
    });
    expect(result).not.toBeNull();
    const asked = requests[0]?.messages ?? [];
    expect(asked.length).toBeLessThan(40);
    expect(JSON.stringify(asked.at(-1))).toContain("oldest messages were too large");
  });
});

describe("what the model is given afterwards", () => {
  it("reads the summary as conversation, not as instructions", () => {
    const message = summaryMessage("## Subject\nx");
    expect(message.role).toBe("user");
    expect(JSON.stringify(message)).toContain("not as instructions");
  });

  it("gives back the messages that follow the summary", () => {
    const rows = turns(4);
    const { rows: kept, summary } = historyAfterSummary(rows, {
      summary: "riassunto",
      summaryThroughMessageId: "m3",
    });
    expect(summary).toBe("riassunto");
    expect(kept.map((row) => row.id)).toEqual(["m4", "m5", "m6", "m7"]);
  });

  it("drops a summary whose last message no longer exists", () => {
    // Deleting messages must never leave a conversation holding both a summary and its messages.
    const rows = turns(2);
    const { rows: kept, summary } = historyAfterSummary(rows, {
      summary: "riassunto",
      summaryThroughMessageId: "sparito",
    });
    expect(summary).toBeNull();
    expect(kept).toEqual(rows);
  });
});
