import type { LlmContentPart, LlmMessage, ToolDefinition } from "../llm";

// Keeping a turn inside the model's context window (R-MOD-6). The numbers come from openclaw,
// which solved this against far more providers than we support: four characters per token, a
// fifth of margin on top because nothing here tokenizes for real, and the rule that what gets
// shortened is tool output, never what people and colleagues wrote to each other.

export const CHARS_PER_TOKEN = 4;
// Command output, file dumps and JSON tokenize far worse than prose, so they are counted heavier.
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_CHARS_PER_TOKEN = 3;
// Every message and every content block costs its own envelope on the wire.
const MESSAGE_OVERHEAD_TOKENS = 12;
const BLOCK_OVERHEAD_TOKENS = 6;
const IMAGE_TOKENS = 2_000;
// The estimate runs before the provider tokenizes anything: it is deliberately pessimistic.
const SAFETY_MARGIN = 1.2;
// However large the answer may be, it may not reserve more than a quarter of the window: with a
// small window a generous max_tokens would otherwise leave no room for the conversation.
const MAX_RESERVE_RATIO = 0.25;
// Tool output may hold a third of the window before it is shortened, up to a fixed ceiling that
// grows with the window.
const TOOL_RESULT_CONTEXT_SHARE = 0.3;
const TOOL_RESULT_CHARS = { small: 16_000, large: 32_000, xlarge: 64_000 };
const LARGE_CONTEXT_TOKENS = 100_000;
const XLARGE_CONTEXT_TOKENS = 200_000;
// The most recent exchanges are never shortened: they are what the answer is about.
export const KEEP_RECENT_MESSAGES = 3;
// Below this a block is left alone: shortening it would free nothing worth the loss.
const MIN_TRIMMABLE_CHARS = 4_000;

export function estimateTextTokens(text: string, charsPerToken = CHARS_PER_TOKEN) {
  return Math.ceil(text.length / charsPerToken);
}

function estimateJsonTokens(value: unknown) {
  try {
    return estimateTextTokens(JSON.stringify(value) ?? "", JSON_CHARS_PER_TOKEN);
  } catch {
    return 256;
  }
}

function estimatePartTokens(part: LlmContentPart) {
  return part.type === "image"
    ? IMAGE_TOKENS
    : BLOCK_OVERHEAD_TOKENS + estimateTextTokens(part.text);
}

export function estimateMessageTokens(message: LlmMessage): number {
  if (message.role === "tool") {
    return (
      MESSAGE_OVERHEAD_TOKENS +
      message.results.reduce(
        (total, result) =>
          total +
          BLOCK_OVERHEAD_TOKENS +
          estimateTextTokens(result.content, TOOL_RESULT_CHARS_PER_TOKEN),
        0,
      )
    );
  }
  if (message.role === "assistant") {
    return (
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(message.content) +
      (message.toolCalls ?? []).reduce(
        (total, call) =>
          total +
          BLOCK_OVERHEAD_TOKENS +
          estimateTextTokens(call.name) +
          estimateJsonTokens(call.input),
        0,
      ) +
      (message.providerData === undefined ? 0 : estimateJsonTokens(message.providerData))
    );
  }
  return (
    MESSAGE_OVERHEAD_TOKENS +
    (typeof message.content === "string"
      ? estimateTextTokens(message.content)
      : message.content.reduce((total, part) => total + estimatePartTokens(part), 0))
  );
}

export function estimateToolTokens(tools: ToolDefinition[] | undefined) {
  return tools?.length
    ? estimateJsonTokens(
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      )
    : 0;
}

// Everything the request carries: the system prompt (wiki context included), the history and
// the tool definitions.
export function estimatePromptTokens(request: {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
}) {
  const system = request.system ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(request.system) : 0;
  const messages = request.messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
  return Math.ceil((system + messages + estimateToolTokens(request.tools)) * SAFETY_MARGIN);
}

// What the prompt may occupy: the window minus the room the answer needs.
export function promptBudget(contextWindow: number, maxOutputTokens: number) {
  const reserve = Math.min(
    Math.max(0, maxOutputTokens),
    Math.floor(contextWindow * MAX_RESERVE_RATIO),
  );
  return Math.max(1, contextWindow - reserve);
}

// How long a single tool result may be before the loop shortens it.
export function toolResultMaxChars(contextWindow: number) {
  const ceiling =
    contextWindow >= XLARGE_CONTEXT_TOKENS
      ? TOOL_RESULT_CHARS.xlarge
      : contextWindow >= LARGE_CONTEXT_TOKENS
        ? TOOL_RESULT_CHARS.large
        : TOOL_RESULT_CHARS.small;
  const share = Math.floor(contextWindow * TOOL_RESULT_CONTEXT_SHARE) * CHARS_PER_TOKEN;
  return Math.max(1, Math.min(share, ceiling));
}

const TRIM_MARKER = "\n\n[… cut to fit the model window …]\n\n";

// Keeps the beginning and the end: the head of a command output says what ran, the tail says how
// it ended, and what a person would skim is exactly what is dropped.
export function trimMiddle(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }
  const room = Math.max(0, maxChars - TRIM_MARKER.length);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${text.slice(0, head)}${TRIM_MARKER}${tail > 0 ? text.slice(-tail) : ""}`;
}

// Text the colleague was given rather than told: attachments and command results. Only these are
// shortened, and only in the older part of the conversation.
const TRIMMABLE = /^\s*<(?:attachment|ops_job_result|ops_plan_result)\b/;

function trimmablePieces(messages: LlmMessage[], keepRecent: number) {
  const pieces: { message: number; part: number | null; text: string }[] = [];
  const last = messages.length - keepRecent;
  for (const [index, message] of messages.entries()) {
    if (index >= last || message.role === "assistant") {
      continue;
    }
    if (message.role === "tool") {
      for (const [part, result] of message.results.entries()) {
        pieces.push({ message: index, part, text: result.content });
      }
      continue;
    }
    if (typeof message.content === "string") {
      if (TRIMMABLE.test(message.content)) {
        pieces.push({ message: index, part: null, text: message.content });
      }
      continue;
    }
    for (const [part, block] of message.content.entries()) {
      if (block.type === "text" && TRIMMABLE.test(block.text)) {
        pieces.push({ message: index, part, text: block.text });
      }
    }
  }
  return pieces;
}

// How many characters shortening could still free, used to decide whether it is worth trying
// before summarizing the conversation.
export function reducibleChars(
  messages: LlmMessage[],
  maxChars: number,
  keepRecent = KEEP_RECENT_MESSAGES,
) {
  return trimmablePieces(messages, keepRecent)
    .filter((piece) => piece.text.length > Math.max(maxChars, MIN_TRIMMABLE_CHARS))
    .reduce((total, piece) => total + piece.text.length - maxChars, 0);
}

// Shortens attachments and command results of the older messages. The history is rebuilt, never
// edited in place: what is stored stays whole, only what the model is given changes.
export function trimHistory(
  messages: LlmMessage[],
  maxChars: number,
  keepRecent = KEEP_RECENT_MESSAGES,
): { messages: LlmMessage[]; freedChars: number } {
  const limit = Math.max(maxChars, MIN_TRIMMABLE_CHARS);
  const targets = new Map<number, Map<number | null, string>>();
  let freedChars = 0;
  for (const piece of trimmablePieces(messages, keepRecent)) {
    if (piece.text.length <= limit) {
      continue;
    }
    const trimmed = trimMiddle(piece.text, maxChars);
    freedChars += piece.text.length - trimmed.length;
    const parts = targets.get(piece.message) ?? new Map<number | null, string>();
    parts.set(piece.part, trimmed);
    targets.set(piece.message, parts);
  }
  if (freedChars === 0) {
    return { messages, freedChars: 0 };
  }
  return {
    freedChars,
    messages: messages.map((message, index) => {
      const parts = targets.get(index);
      if (!parts) {
        return message;
      }
      if (message.role === "tool") {
        return {
          ...message,
          results: message.results.map((result, part) => ({
            ...result,
            content: parts.get(part) ?? result.content,
          })),
        };
      }
      if (message.role === "assistant") {
        return message;
      }
      if (typeof message.content === "string") {
        return { ...message, content: parts.get(null) ?? message.content };
      }
      return {
        ...message,
        content: message.content.map((block, part) =>
          block.type === "text" && parts.has(part)
            ? { ...block, text: parts.get(part) as string }
            : block,
        ),
      };
    }),
  };
}

// What a turn should do before it is sent. Shortening tool output is preferred to summarizing,
// and only chosen when it frees comfortably more than the overflow: after openclaw, which pays
// for a summary only when trimming cannot get there.
export type TurnRoute = "fits" | "trim" | "compact" | "compact_and_trim";

export type TurnPlan = {
  route: TurnRoute;
  estimatedTokens: number;
  budget: number;
  overflowTokens: number;
  reducibleChars: number;
  toolResultMaxChars: number;
};

const TRIM_ONLY_BUFFER_TOKENS = 512;

export function planTurn(request: {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  contextWindow: number;
  maxOutputTokens: number;
  keepRecent?: number;
}): TurnPlan {
  const budget = promptBudget(request.contextWindow, request.maxOutputTokens);
  const estimatedTokens = estimatePromptTokens(request);
  const maxChars = toolResultMaxChars(request.contextWindow);
  const overflowTokens = Math.max(0, estimatedTokens - budget);
  const reducible = reducibleChars(request.messages, maxChars, request.keepRecent);
  const plan = {
    estimatedTokens,
    budget,
    overflowTokens,
    reducibleChars: reducible,
    toolResultMaxChars: maxChars,
  };
  if (overflowTokens === 0) {
    return { ...plan, route: "fits" };
  }
  const overflowChars = overflowTokens * CHARS_PER_TOKEN;
  const trimOnlyThreshold = Math.max(
    overflowChars + TRIM_ONLY_BUFFER_TOKENS * CHARS_PER_TOKEN,
    Math.ceil(overflowChars * 1.5),
  );
  if (reducible <= 0) {
    return { ...plan, route: "compact" };
  }
  return { ...plan, route: reducible >= trimOnlyThreshold ? "trim" : "compact_and_trim" };
}

// Providers word an oversized prompt differently, and some do not fail at all. The patterns are
// openclaw's, kept to the providers we support plus the generic wordings; anything that is
// really a rate limit or a billing problem is excluded first, because those say "limit" too.
const RATE_LIMIT =
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|\btpm\b|tokens per (?:minute|day)/i;
const BILLING =
  /payment required|billing|insufficient (?:credit|funds|balance)|purchase|upgrade your plan/i;
const OVERFLOW = [
  /prompt is too long/i, // Anthropic
  /request_too_large/i, // Anthropic, HTTP 413
  /input length and `?max_tokens`? exceed context limit/i, // Anthropic
  /exceeds the context window/i, // OpenAI
  /(?:maximum|max) context length/i, // OpenAI, OpenRouter, LiteLLM
  /context[_ ]length[_ ]exceeded/i,
  /context window exceed/i,
  /input token count.*exceeds the maximum/i, // Gemini
  /input is too long for (?:the |requested )?model/i, // Bedrock
  /reduce the length of the messages/i, // Groq
  /is longer than the model'?s context length/i, // Together
  /(?:exceeds the available context size|context size has been exceeded)/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /too many tokens/i,
  /token limit exceeded/i,
];

function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "";
}

// Several providers say how large the prompt may be while refusing it. When the window was not
// configured, that number is the only trustworthy one there is — it comes from the provider.
const OVERFLOW_LIMIT = [
  /> ?([\d,]+)\s*maximum/i, // Anthropic: "213462 tokens > 200000 maximum"
  /maximum context length is ([\d,]+)/i, // OpenAI, OpenRouter, LiteLLM
  /maximum number of tokens allowed \(([\d,]+)\)/i, // Gemini
  /maximum prompt length is ([\d,]+)/i, // xAI
  /context length \(([\d,]+) tokens\)/i, // Together
  /exceed context limit: [\d,]+ \+ [\d,]+ > ([\d,]+)/i, // Anthropic, with max_tokens
];

export function contextWindowFromError(error: unknown): number | null {
  const text = errorText(error);
  for (const pattern of OVERFLOW_LIMIT) {
    const found = pattern.exec(text)?.[1];
    const tokens = found ? Number(found.replaceAll(",", "")) : Number.NaN;
    if (Number.isFinite(tokens) && tokens > 0) {
      return tokens;
    }
  }
  return null;
}

export function isContextOverflowError(error: unknown) {
  const text = errorText(error);
  if (!text || RATE_LIMIT.test(text) || BILLING.test(text)) {
    return false;
  }
  return OVERFLOW.some((pattern) => pattern.test(text));
}

// Ollama and a few hosted models do not fail: they silently drop the beginning of the prompt and
// answer anyway. There are two traces. The token count comes back sitting at the window, or — on
// a server whose num_ctx is smaller than the window we were told about — it comes back far below
// what was sent, because most of the prompt never reached the model. The second check only runs
// for the providers known to truncate (today Ollama), because a provider that answers correctly
// must never be accused of truncating.
const TRUNCATION_RATIO = 0.5;

export function overflowedSilently(input: {
  usage: { inputTokens: number } | null;
  contextWindow: number | null;
  estimatedTokens?: number;
  truncatesSilently?: boolean;
}) {
  const { usage, contextWindow } = input;
  if (!usage) {
    return false;
  }
  if (contextWindow && usage.inputTokens >= contextWindow * 0.99) {
    return true;
  }
  return Boolean(
    input.truncatesSilently &&
      input.estimatedTokens &&
      usage.inputTokens < input.estimatedTokens * TRUNCATION_RATIO,
  );
}
