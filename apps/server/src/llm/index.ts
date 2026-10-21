import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createAnthropicClient } from "./anthropic";
import { createOpenAiClient } from "./openai";
import type { LlmClientFactory } from "./types";

export * from "./types";

export const createLlmClient: LlmClientFactory = (connection) =>
  connection.kind === "anthropic"
    ? createAnthropicClient(connection)
    : createOpenAiClient(connection);

export function isProviderError(error: unknown) {
  return error instanceof Anthropic.APIError || error instanceof OpenAI.APIError;
}

// Short technical description of a provider failure, safe to show to administrators.
export function describeProviderError(error: unknown): string {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return error.status ? `${error.status}: ${error.message}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown provider error";
}
