import Anthropic from "@anthropic-ai/sdk";
import type { ProviderModel } from "@orlok/shared";
import {
  type LlmClient,
  type LlmMessage,
  ModelRefusalError,
  type ProviderConnection,
  type ToolCall,
} from "./types";

// Everything the prompt cost, which is not what `input_tokens` says: with prompt caching on —
// and a proxy in front usually turns it on — that field counts only what the cache did not
// serve, a handful of tokens, while the conversation itself is billed under the cache fields.
// Adding them up is the only number that answers "how full is the window".
export function promptTokens(usage: Anthropic.Usage) {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

// Blocks of a response that are sent back in the next request of a tool loop. Thinking blocks
// must be returned unchanged, so they travel as providerData.
function toParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    default:
      return null;
  }
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolCallId,
          content: result.content,
          is_error: result.isError,
        })),
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content = Array.isArray(message.providerData)
        ? (message.providerData as Anthropic.ContentBlockParam[])
        : [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ];
      return { role: "assistant", content };
    }
    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) =>
                part.type === "text"
                  ? { type: "text" as const, text: part.text }
                  : {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: part.mimeType,
                        data: part.data,
                      },
                    },
              ),
      };
    }
    return { role: "assistant", content: message.content };
  });
}

// Anthropic API, or any Anthropic-compatible proxy when baseUrl points to its root URL.
export function createAnthropicClient({ baseUrl, apiKey }: ProviderConnection): LlmClient {
  const client = new Anthropic({
    // Always pass the key explicitly so ANTHROPIC_* variables of the host are never picked up.
    // Proxies that ignore authentication still need a non-empty value.
    apiKey: apiKey ?? "not-set",
    baseURL: baseUrl ?? undefined,
    maxRetries: 1,
  });

  return {
    async listModels() {
      const models: ProviderModel[] = [];
      for await (const model of client.models.list()) {
        models.push({
          id: model.id,
          maxOutputTokens: model.max_tokens ?? null,
          contextWindow: model.max_input_tokens ?? null,
        });
      }
      return models;
    },

    async *streamChat({ model, system, messages, tools, maxOutputTokens, signal }) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxOutputTokens,
          messages: toAnthropicMessages(messages),
          ...(system ? { system } : {}),
          // eager_input_streaming is left off: compatible proxies may reject unknown tool fields.
          ...(tools?.length
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
              }
            : {}),
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          yield { type: "tool_start", name: event.content_block.name };
        }
      }

      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        throw new ModelRefusalError(message.stop_details?.explanation ?? undefined);
      }
      const calls: ToolCall[] = message.content.flatMap((block) =>
        block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
      );
      if (calls.length > 0) {
        yield {
          type: "tool_calls",
          calls,
          providerData: message.content.map(toParam).filter((block) => block !== null),
        };
      }
      yield {
        type: "done",
        stopReason: message.stop_reason,
        usage: {
          inputTokens: promptTokens(message.usage),
          outputTokens: message.usage.output_tokens,
          cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
