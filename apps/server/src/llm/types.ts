import type { ProviderKind, ProviderModel, TokenUsage } from "@orlok/shared";

// Provider-neutral model access used by the rest of the server (R-MOD-1).

export type ProviderConnection = {
  kind: ProviderKind;
  baseUrl: string | null;
  apiKey: string | null;
};

// A function the model may call; inputSchema is a JSON Schema object.
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

// input is whatever the model produced: it must be validated before use.
export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ToolResult = {
  toolCallId: string;
  content: string;
  isError: boolean;
};

// Images travel base64-encoded, e.g. scanned pages and figures of documents.
export type LlmContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      data: string;
    };

export type LlmMessage =
  | { role: "user"; content: string | LlmContentPart[] }
  // providerData carries provider-specific blocks (e.g. thinking) that must be sent back as they are.
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; providerData?: unknown }
  | { role: "tool"; results: ToolResult[] };

export type ChatRequest = {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type ChatChunk =
  | { type: "text"; text: string }
  // The model has begun writing a tool call, which may take a while to complete (a whole wiki
  // page is written as the call's input). Only from providers that stream calls as they grow.
  | { type: "tool_start"; name: string }
  | { type: "tool_calls"; calls: ToolCall[]; providerData?: unknown }
  | { type: "done"; stopReason: string | null; usage: TokenUsage | null };

export interface LlmClient {
  listModels(): Promise<ProviderModel[]>;
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
  // Only providers that offer embeddings implement it.
  embed?(request: { model: string; texts: string[]; signal?: AbortSignal }): Promise<number[][]>;
}

export type LlmClientFactory = (connection: ProviderConnection) => LlmClient;

export class ModelRefusalError extends Error {
  constructor(message = "The model declined the request") {
    super(message);
    this.name = "ModelRefusalError";
  }
}
