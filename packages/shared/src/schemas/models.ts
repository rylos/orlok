import { z } from "zod";
import {
  CHAT_ROLES,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_LIMIT,
  PROVIDER_KINDS,
} from "../models";
import { EXEC_MODES } from "../ops";
import { issue } from "./issue";

const nameSchema = z.string().trim().min(1, issue("required")).max(80, issue("too_long"));
const baseUrlSchema = z
  .url({ protocol: /^https?$/, error: "invalid_url" })
  .max(500, issue("too_long"));
const apiKeySchema = z.string().max(4096, issue("too_long"));

export const providerCreateSchema = z
  .object({
    name: nameSchema,
    kind: z.enum(PROVIDER_KINDS),
    baseUrl: baseUrlSchema.nullable().optional(),
    apiKey: apiKeySchema.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "openai_compatible" && !value.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "required" });
    }
  });

// The provider kind cannot change. `apiKey`: omitted keeps the saved key, null removes it.
export const providerUpdateSchema = z.object({
  name: nameSchema.optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  apiKey: apiKeySchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

const modelIdSchema = z.string().trim().min(1, issue("required")).max(200, issue("too_long"));
const maxOutputTokensSchema = z
  .number(issue("invalid_max_output_tokens"))
  .int(issue("invalid_max_output_tokens"))
  .min(1, issue("invalid_max_output_tokens"))
  .max(MAX_OUTPUT_TOKENS_LIMIT, issue("invalid_max_output_tokens"));

// Null means "unknown": the turn is then only protected by the provider's own overflow error.
const contextWindowSchema = z
  .number(issue("invalid_context_window"))
  .int(issue("invalid_context_window"))
  .min(CONTEXT_WINDOW_MIN, issue("invalid_context_window"))
  .max(CONTEXT_WINDOW_MAX, issue("invalid_context_window"));

// A profile is a model and a mode (R-MOD-2). Once created only its name changes: a different
// model or mode is a different profile, so what a colleague may do never shifts under it.
export const profileCreateSchema = z.object({
  name: nameSchema,
  providerId: z.uuid(issue("invalid_value")),
  model: modelIdSchema,
  mode: z.enum(EXEC_MODES, issue("required")),
  maxOutputTokens: maxOutputTokensSchema.default(DEFAULT_MAX_OUTPUT_TOKENS),
  contextWindow: contextWindowSchema.nullable().default(null),
});

export const profileUpdateSchema = z.object({
  name: nameSchema,
});

const chatTurnSchema = z.object({
  role: z.enum(CHAT_ROLES),
  content: z.string().min(1, issue("required")).max(100_000, issue("too_long")),
});

// Admin playground: try a profile before assigning it to a colleague.
export const playgroundSchema = z.object({
  profileId: z.uuid(issue("invalid_value")),
  messages: z.array(chatTurnSchema).min(1, issue("required")).max(100, issue("too_long")),
});
