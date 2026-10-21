import type { EmbeddingOverview, EmbeddingSettings, EmbeddingTestResult } from "@orlok/shared";
import { embeddingSettingsSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { isLocalEmbeddingAvailable } from "../../embeddings-local";
import { errorBody } from "../../lib/errors";
import { validate } from "../../lib/validation";
import { describeProviderError } from "../../llm";
import {
  embedderFor,
  embeddingFailure,
  embeddingModelName,
  embeddingStatus,
  getEmbeddingSettings,
  saveEmbeddingSettings,
} from "../../services/embeddings";
import { findProvider } from "../../services/models";
import type { AppEnv, Deps } from "../../types";

const invalidProvider = errorBody(
  "validation_failed",
  "Choose a provider that offers embeddings (OpenAI, OpenAI-compatible or Ollama)",
  [{ path: "providerId", code: "invalid_value" }],
);

// Semantic memory settings (embeddings of wiki pages), administrators only.
export function embeddingRoutes({ db, config, llm, localEmbedder }: Deps) {
  const deps = { db, llm, localEmbedder, secretKey: config.secretKey };

  async function invalid(input: EmbeddingSettings) {
    if (input.mode !== "provider") {
      return false;
    }
    const provider = input.providerId ? await findProvider(db, input.providerId) : null;
    return !provider || provider.kind === "anthropic" || !input.model;
  }

  async function overview(current: EmbeddingSettings): Promise<EmbeddingOverview> {
    return {
      ...current,
      ...(await embeddingStatus(db, embeddingModelName(current))),
      builtinAvailable: await isLocalEmbeddingAvailable(),
      lastError: current.mode === "off" ? null : embeddingFailure(),
    };
  }

  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await overview(await getEmbeddingSettings(db))))
    .put("/", validate("json", embeddingSettingsSchema), async (c) => {
      const input = c.req.valid("json");
      if (await invalid(input)) {
        return c.json(invalidProvider, 400);
      }
      return c.json(await overview(await saveEmbeddingSettings(db, input)));
    })
    .post("/test", validate("json", embeddingSettingsSchema), async (c) => {
      const input = c.req.valid("json");
      if (await invalid(input)) {
        return c.json(invalidProvider, 400);
      }
      try {
        const embedder = await embedderFor(deps, input);
        if (!embedder) {
          return c.json({
            ok: false,
            message:
              input.mode === "builtin"
                ? "The built-in model is not installed"
                : "Choose an enabled provider and a model",
          } satisfies EmbeddingTestResult);
        }
        const [vector] = await embedder.embed(["Orlok"], "query");
        return c.json({ ok: true, dimensions: vector?.length ?? 0 } satisfies EmbeddingTestResult);
      } catch (error) {
        return c.json({
          ok: false,
          message: describeProviderError(error),
        } satisfies EmbeddingTestResult);
      }
    });
}
