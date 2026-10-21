import type { z } from "zod";
import type { ErrorCode } from "./errors";
import type { ExecMode, OpsJob } from "./ops";
import type {
  playgroundSchema,
  profileCreateSchema,
  profileUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
} from "./schemas/models";
import type { WikiEdit, WikiPageRef } from "./wiki";

// Model providers and profiles configured from the admin panel (R-MOD-1, R-MOD-2).
export const PROVIDER_KINDS = ["anthropic", "openai", "openai_compatible", "ollama"] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

// The largest answer any model we know allows: DeepSeek V4 states 384K, where Claude 5 stops at
// 128K. A profile above what its own model allows is refused with the provider's number.
export const MAX_OUTPUT_TOKENS_LIMIT = 384_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

// How much a model can read in one request. Providers rarely publish it (Anthropic and Ollama
// do, the OpenAI API does not), so a profile keeps the number an administrator sets. Without it
// a turn cannot be measured beforehand: it is only recovered from the provider's overflow error.
export const CONTEXT_WINDOW_MIN = 4_096;
export const CONTEXT_WINDOW_MAX = 10_000_000;

export const CHAT_ROLES = ["user", "assistant"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export type ChatTurn = {
  role: ChatRole;
  content: string;
};

export type ProviderCreateInput = z.input<typeof providerCreateSchema>;
export type ProviderUpdateInput = z.input<typeof providerUpdateSchema>;
export type ProfileCreateInput = z.input<typeof profileCreateSchema>;
export type ProfileUpdateInput = z.input<typeof profileUpdateSchema>;
export type PlaygroundInput = z.input<typeof playgroundSchema>;

export type ModelProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  // The key itself never leaves the server.
  hasApiKey: boolean;
  enabled: boolean;
  createdAt: string;
};

export type ModelProfile = {
  id: string;
  name: string;
  providerId: string;
  model: string;
  // How colleagues with this profile may run commands (R-OPS-4).
  mode: ExecMode;
  maxOutputTokens: number;
  contextWindow: number | null;
  createdAt: string;
};

// A model offered by a provider. Limits are null when the provider does not publish them.
export type ProviderModel = {
  id: string;
  maxOutputTokens: number | null;
  contextWindow: number | null;
};

export type ProviderModelsResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; message: string };

// inputTokens is the whole prompt; the cached parts, when the provider reports them, are
// included in it and priced at their own rates (R-MOD-4).
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
};

// What changed for the signed-in person somewhere else (another tab, Telegram, a follow-up after
// an approval), sent on /api/me/events so open pages refresh (R-CHAT-13). A null conversation
// means all of the colleague's conversations; `deleted` that it is gone.
export type LiveEvent = {
  type: "conversation";
  colleagueId: string;
  conversationId: string | null;
  deleted?: boolean;
};

// Events of a streamed chat response (server-sent events, one JSON object per event).
export type ChatStreamEvent =
  // Pages given to the colleague before answering, and those it used: read or cited (R-MEM-4).
  | { type: "context"; pages: WikiPageRef[] }
  | { type: "wiki_used"; pages: WikiPageRef[] }
  // The colleague is using a tool, e.g. searching or updating the wiki.
  | { type: "tool"; name: string }
  // A command the colleague runs or asks to run, and its updates (R-OPS).
  | { type: "ops_job"; job: OpsJob }
  | { type: "wiki_edit"; edit: WikiEdit }
  | { type: "text"; text: string }
  | { type: "done"; stopReason: string | null; usage: TokenUsage | null }
  | { type: "error"; code: ErrorCode; message: string };
