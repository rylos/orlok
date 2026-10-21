import type { ChatStreamEvent } from "@orlok/shared";
import { playgroundSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { errorBody } from "../../lib/errors";
import { validate } from "../../lib/validation";
import { describeProviderError, ModelRefusalError } from "../../llm";
import { metered } from "../../services/costs";
import { connectionFor, findProfileWithProvider } from "../../services/models";
import type { AppEnv, Deps } from "../../types";

// Streams a test conversation with a model profile, administrators only.
export function playgroundRoutes(deps: Deps) {
  const { db, config, llm } = deps;
  return new Hono<AppEnv>().post("/", validate("json", playgroundSchema), async (c) => {
    const { profileId, messages } = c.req.valid("json");
    const row = await findProfileWithProvider(db, profileId);
    if (!row) {
      return c.json(errorBody("not_found", "Profile not found"), 404);
    }
    if (!row.provider.enabled) {
      return c.json(errorBody("conflict", "The profile's provider is disabled"), 409);
    }

    // Metered like every call, never stopped by a limit: it is how a provider is tested.
    const client = metered(deps, llm(connectionFor(row.provider, config.secretKey)), {
      purpose: "playground",
      provider: row.provider,
      userId: c.get("user")?.id ?? null,
      enforce: false,
    });

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const send = (event: ChatStreamEvent) => stream.writeSSE({ data: JSON.stringify(event) });

      try {
        for await (const chunk of client.streamChat({
          model: row.profile.model,
          maxOutputTokens: row.profile.maxOutputTokens,
          messages,
          signal: controller.signal,
        })) {
          // No tools are offered here, so tool calls never arrive.
          if (chunk.type !== "tool_calls" && chunk.type !== "tool_start") {
            await send(chunk);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        await send({
          type: "error",
          code: error instanceof ModelRefusalError ? "model_refused" : "provider_error",
          message: describeProviderError(error),
        });
      }
    });
  });
}
