import type { ProviderKind, ProviderModel, TokenUsage } from "@orlok/shared";
import OpenAI from "openai";
import type { LlmClient, LlmMessage, ProviderConnection, ToolCall } from "./types";

const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: "http://localhost:11434/v1",
};

function toOpenAiMessages(
  system: string | undefined,
  messages: LlmMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = system
    ? [{ role: "system", content: system }]
    : [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const item of message.results) {
        result.push({ role: "tool", tool_call_id: item.toolCallId, content: item.content });
      }
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      result.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) =>
                part.type === "text"
                  ? { type: "text" as const, text: part.text }
                  : {
                      type: "image_url" as const,
                      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
                    },
              ),
      });
    } else {
      result.push({ role: "assistant", content: message.content });
    }
  }
  return result;
}

// Ollama publishes what a model can read, but only outside the OpenAI-compatible surface: its
// own /api/show reports the context length of the loaded weights, under a key named after the
// architecture (llama.context_length, qwen3.context_length, …). Worth the extra call: a model
// served with a smaller num_ctx than it could take silently drops the beginning of the prompt.
const OLLAMA_MODELS_QUERIED = 25;

// What the server will actually serve, when the Modelfile pins it: a model able to read 128k
// tokens still truncates at num_ctx, and silently.
function pinnedContextLength(parameters: unknown) {
  const found =
    typeof parameters === "string" ? /^\s*num_ctx\s+(\d+)/m.exec(parameters)?.[1] : undefined;
  const tokens = found ? Number(found) : Number.NaN;
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

async function ollamaContextWindow(root: string, model: string): Promise<number | null> {
  try {
    const response = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      model_info?: Record<string, unknown>;
      parameters?: unknown;
    };
    const pinned = pinnedContextLength(body.parameters);
    if (pinned) {
      return pinned;
    }
    for (const [key, value] of Object.entries(body.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
        return value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Tool call arguments arrive as JSON text; invalid JSON becomes undefined and fails validation.
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return undefined;
  }
}

// OpenAI API and OpenAI-compatible servers (including Ollama's /v1 endpoint).
export function createOpenAiClient({ kind, baseUrl, apiKey }: ProviderConnection): LlmClient {
  const client = new OpenAI({
    // Always explicit, so OPENAI_* variables of the host are never picked up.
    apiKey: apiKey ?? "not-set",
    baseURL: baseUrl ?? DEFAULT_BASE_URLS[kind],
    maxRetries: 1,
  });

  return {
    async listModels() {
      const models: ProviderModel[] = [];
      for await (const model of client.models.list()) {
        // The OpenAI models API publishes no token limits at all.
        models.push({ id: model.id, maxOutputTokens: null, contextWindow: null });
      }
      if (kind !== "ollama") {
        return models;
      }
      const root = (baseUrl ?? DEFAULT_BASE_URLS.ollama ?? "").replace(/\/v1\/?$/, "");
      for (const model of models.slice(0, OLLAMA_MODELS_QUERIED)) {
        model.contextWindow = await ollamaContextWindow(root, model.id);
      }
      return models;
    },

    async embed({ model, texts, signal }) {
      const response = await client.embeddings.create({ model, input: texts }, { signal });
      return [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },

    async *streamChat({ model, system, messages, tools, maxOutputTokens, signal }) {
      const stream = await client.chat.completions.create(
        {
          model,
          stream: true,
          stream_options: { include_usage: true },
          // The official API wants max_completion_tokens; compatible servers expect max_tokens.
          ...(kind === "openai"
            ? { max_completion_tokens: maxOutputTokens }
            : { max_tokens: maxOutputTokens }),
          messages: toOpenAiMessages(system, messages),
          ...(tools?.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
        },
        { signal },
      );

      let stopReason: string | null = null;
      let usage: TokenUsage | null = null;
      const pending = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          yield { type: "text", text: choice.delta.content };
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
          const known = pending.get(call.index);
          if (!known && call.function?.name) {
            yield { type: "tool_start", name: call.function.name };
          }
          const entry = known ?? { id: "", name: "", arguments: "" };
          entry.id ||= call.id ?? "";
          entry.name += call.function?.name ?? "";
          entry.arguments += call.function?.arguments ?? "";
          pending.set(call.index, entry);
        }
        if (choice?.finish_reason) {
          stopReason = choice.finish_reason;
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
      if (pending.size > 0) {
        const calls: ToolCall[] = [...pending.entries()].map(([index, entry]) => ({
          // Some compatible servers (e.g. Ollama) omit call ids.
          id: entry.id || `call_${index}`,
          name: entry.name,
          input: parseArguments(entry.arguments),
        }));
        yield { type: "tool_calls", calls };
      }
      yield { type: "done", stopReason, usage };
    },
  };
}
