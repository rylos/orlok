import { describe, expect, it } from "vitest";
import type { LlmMessage } from "../llm";
import {
  estimateMessageTokens,
  estimatePromptTokens,
  isContextOverflowError,
  overflowedSilently,
  planTurn,
  promptBudget,
  reducibleChars,
  toolResultMaxChars,
  trimHistory,
  trimMiddle,
} from "./context";

// What a turn costs has to be known before it is sent: the provider only says "too long" when it
// is already too late, and some providers do not say it at all.

const attachment = (size: number) =>
  `<attachment file="report.pdf">\n${"parola ".repeat(size)}\n</attachment>`;

describe("measuring a turn", () => {
  it("counts command output heavier than prose", () => {
    const text = "x".repeat(4_000);
    const prose = estimateMessageTokens({ role: "user", content: text });
    const output = estimateMessageTokens({
      role: "tool",
      results: [{ toolCallId: "1", content: text, isError: false }],
    });
    expect(output).toBeGreaterThan(prose);
  });

  it("counts an image as a block of its own, not as its base64", () => {
    const tokens = estimateMessageTokens({
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "A".repeat(200_000) }],
    });
    expect(tokens).toBeLessThan(3_000);
  });

  it("adds the system prompt and the tool definitions", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "ciao" }];
    const bare = estimatePromptTokens({ messages });
    const full = estimatePromptTokens({
      messages,
      system: "x".repeat(8_000),
      tools: [
        {
          name: "ops_exec",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    });
    expect(full).toBeGreaterThan(bare + 2_000);
  });

  it("never lets the answer reserve more than a quarter of the window", () => {
    expect(promptBudget(8_000, 1_000)).toBe(7_000);
    // A max_tokens larger than the window would otherwise leave no room at all.
    expect(promptBudget(8_000, 64_000)).toBe(6_000);
  });

  it("gives a bigger tool-result allowance to a bigger window", () => {
    expect(toolResultMaxChars(8_000)).toBeLessThan(toolResultMaxChars(200_000));
    expect(toolResultMaxChars(1_000_000)).toBe(64_000);
  });
});

describe("shortening what was given rather than said", () => {
  it("keeps the beginning and the end of a long result", () => {
    const text = `START${"x".repeat(10_000)}END`;
    const trimmed = trimMiddle(text, 1_000);
    expect(trimmed.length).toBeLessThanOrEqual(1_000);
    expect(trimmed.startsWith("START")).toBe(true);
    expect(trimmed.endsWith("END")).toBe(true);
  });

  it("shortens attachments and command results, never the conversation", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: attachment(4_000) },
      { role: "assistant", content: "x".repeat(20_000) },
      { role: "user", content: "y".repeat(20_000) },
      { role: "user", content: "e adesso?" },
      { role: "assistant", content: "ecco" },
      { role: "user", content: "grazie" },
    ];
    const { messages: trimmed, freedChars } = trimHistory(messages, 2_000);

    expect(freedChars).toBeGreaterThan(20_000);
    expect(String(trimmed[0]?.role === "user" ? trimmed[0].content : "").length).toBeLessThan(
      3_000,
    );
    // What people and colleagues wrote is untouched, however long.
    expect(trimmed[1]).toEqual(messages[1]);
    expect(trimmed[2]).toEqual(messages[2]);
  });

  it("cuts the attachment just sent when that is the only way to send it at all", () => {
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: attachment(40_000) },
          { type: "text", text: "Che ne dici?" },
        ],
      },
    ];
    const { messages: trimmed, freedChars } = trimHistory(messages, 4_000, 0);
    expect(freedChars).toBeGreaterThan(200_000);
    const parts = trimmed[0]?.role === "user" ? trimmed[0].content : [];
    // The question itself is never touched: only what was attached to it.
    expect(parts[1]).toEqual({ type: "text", text: "Che ne dici?" });
    expect(JSON.stringify(parts[0])).toContain("cut to fit");
  });

  it("leaves the most recent exchanges alone", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: attachment(4_000) },
      { role: "assistant", content: "visto" },
      { role: "user", content: attachment(4_000) },
    ];
    const { messages: trimmed, freedChars } = trimHistory(messages, 2_000);
    expect(freedChars).toBe(0);
    expect(trimmed).toEqual(messages);
  });
});

describe("deciding what a turn should do", () => {
  const tools = undefined;

  it("sends a turn that fits as it is", () => {
    const plan = planTurn({
      messages: [{ role: "user", content: "ciao" }],
      tools,
      contextWindow: 200_000,
      maxOutputTokens: 4_000,
    });
    expect(plan.route).toBe("fits");
    expect(plan.overflowTokens).toBe(0);
  });

  it("shortens tool output when that alone gets the turn back inside", () => {
    const plan = planTurn({
      messages: [
        { role: "user", content: attachment(60_000) },
        { role: "assistant", content: "visto" },
        { role: "user", content: "e allora?" },
        { role: "user", content: "?" },
      ],
      tools,
      contextWindow: 100_000,
      maxOutputTokens: 4_000,
    });
    expect(plan.route).toBe("trim");
  });

  it("summarizes when there is no tool output left to shorten", () => {
    const plan = planTurn({
      messages: Array.from({ length: 20 }, () => ({
        role: "user" as const,
        content: "parola ".repeat(3_000),
      })),
      tools,
      contextWindow: 8_000,
      maxOutputTokens: 1_000,
    });
    expect(plan.route).toBe("compact");
    expect(plan.reducibleChars).toBe(0);
  });

  it("does both when shortening would not be enough on its own", () => {
    const plan = planTurn({
      messages: [
        { role: "user", content: attachment(2_000) },
        ...Array.from({ length: 10 }, () => ({
          role: "user" as const,
          content: "parola ".repeat(2_000),
        })),
      ],
      tools,
      contextWindow: 8_000,
      maxOutputTokens: 1_000,
    });
    expect(plan.route).toBe("compact_and_trim");
  });

  it("counts only what shortening would actually free", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: attachment(10_000) },
      { role: "user", content: "corto" },
      { role: "user", content: "corto" },
      { role: "user", content: "corto" },
    ];
    expect(reducibleChars(messages, 2_000)).toBeGreaterThan(60_000);
    expect(reducibleChars([{ role: "user", content: "corto" }], 2_000)).toBe(0);
  });
});

describe("recognizing a prompt the provider refused for its size", () => {
  it.each([
    "400 prompt is too long: 213462 tokens > 200000 maximum",
    "This model's maximum context length is 128000 tokens",
    "Your input exceeds the context window of this model",
    "input token count (1196265) exceeds the maximum number of tokens allowed",
    "ollama: prompt too long; exceeded max context length",
    "Please reduce the length of the messages or completion",
    "the request exceeds the available context size, try increasing it",
  ])("recognizes %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
  });

  it.each([
    "429 rate limit exceeded, too many requests",
    "413 request too large for gpt-4o in organization: tokens per minute (TPM)",
    "402 Payment Required: credit balance is too low",
    "500 internal server error",
  ])("does not mistake %s for it", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false);
  });

  it("sees the overflow a provider never reports", () => {
    // Ollama answers anyway, having dropped the beginning of the prompt.
    const usage = (inputTokens: number) => ({ inputTokens });
    expect(overflowedSilently({ usage: usage(8_150), contextWindow: 8_192 })).toBe(true);
    expect(overflowedSilently({ usage: usage(4_000), contextWindow: 8_192 })).toBe(false);
    expect(overflowedSilently({ usage: usage(8_150), contextWindow: null })).toBe(false);
  });

  it("sees a prompt the server cut down to its own num_ctx", () => {
    // 40k tokens were sent and 4k were read: the rest never reached the model.
    const cut = { usage: { inputTokens: 4_000 }, contextWindow: 131_072, estimatedTokens: 40_000 };
    expect(overflowedSilently({ ...cut, truncatesSilently: true })).toBe(true);
    // Anthropic reports cached tokens apart, which looks the same and is not.
    expect(overflowedSilently(cut)).toBe(false);
  });
});
