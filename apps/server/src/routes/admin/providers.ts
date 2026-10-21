import type { ProviderModelsResult } from "@orlok/shared";
import { providerCreateSchema, providerUpdateSchema } from "@orlok/shared/schemas";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { modelProfiles, modelProviders } from "../../db/schema";
import { encryptSecret } from "../../lib/crypto";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { describeProviderError } from "../../llm";
import { connectionFor, findProvider, toProvider } from "../../services/models";
import type { AppEnv, Deps } from "../../types";

async function nameTaken(db: Db, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      exceptId
        ? and(eq(modelProviders.name, name), ne(modelProviders.id, exceptId))
        : eq(modelProviders.name, name),
    )
    .limit(1);
  return row !== undefined;
}

const nameConflict = errorBody("conflict", "A provider with this name already exists");
const notFound = errorBody("not_found", "Provider not found");

// Model providers (R-MOD-1), administrators only.
export function providerRoutes({ db, config, llm }: Deps) {
  async function listModels(id: string): Promise<ProviderModelsResult | null> {
    const row = await findProvider(db, id);
    if (!row) {
      return null;
    }
    try {
      const models = await llm(connectionFor(row, config.secretKey)).listModels();
      return { ok: true, models };
    } catch (error) {
      return { ok: false, message: describeProviderError(error) };
    }
  }

  return (
    new Hono<AppEnv>()
      .get("/", async (c) => {
        const rows = await db.select().from(modelProviders).orderBy(asc(modelProviders.name));
        return c.json(rows.map(toProvider));
      })
      .post("/", validate("json", providerCreateSchema), async (c) => {
        const input = c.req.valid("json");
        if (await nameTaken(db, input.name)) {
          return c.json(nameConflict, 409);
        }
        const [row] = await db
          .insert(modelProviders)
          .values({
            name: input.name,
            kind: input.kind,
            baseUrl: input.baseUrl ?? null,
            apiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey, config.secretKey) : null,
            enabled: input.enabled,
            // Local models cost nothing per call (R-MOD-4).
            billing: input.kind === "ollama" ? "included" : "per_token",
          })
          .returning();
        if (!row) {
          throw new Error("Provider insert returned no row");
        }
        return c.json(toProvider(row), 201);
      })
      .patch(
        "/:id",
        validate("param", idParamSchema),
        validate("json", providerUpdateSchema),
        async (c) => {
          const { id } = c.req.valid("param");
          const input = c.req.valid("json");
          const current = await findProvider(db, id);
          if (!current) {
            return c.json(notFound, 404);
          }

          const baseUrl = input.baseUrl === undefined ? current.baseUrl : input.baseUrl;
          if (current.kind === "openai_compatible" && !baseUrl) {
            return c.json(
              errorBody("validation_failed", "Request validation failed", [
                { path: "baseUrl", code: "required" },
              ]),
              400,
            );
          }
          if (input.name !== undefined && (await nameTaken(db, input.name, id))) {
            return c.json(nameConflict, 409);
          }

          const [row] = await db
            .update(modelProviders)
            .set({
              name: input.name,
              baseUrl,
              enabled: input.enabled,
              ...(input.apiKey === undefined
                ? {}
                : {
                    apiKeyEncrypted: input.apiKey
                      ? encryptSecret(input.apiKey, config.secretKey)
                      : null,
                  }),
            })
            .where(eq(modelProviders.id, id))
            .returning();
          if (!row) {
            return c.json(notFound, 404);
          }
          return c.json(toProvider(row));
        },
      )
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        const [usage] = await db
          .select({ total: count() })
          .from(modelProfiles)
          .where(eq(modelProfiles.providerId, id));
        if ((usage?.total ?? 0) > 0) {
          return c.json(errorBody("conflict", "The provider is used by model profiles"), 409);
        }
        const deleted = await db
          .delete(modelProviders)
          .where(eq(modelProviders.id, id))
          .returning({ id: modelProviders.id });
        return deleted.length > 0 ? c.body(null, 204) : c.json(notFound, 404);
      })
      // Lists the provider's models: doubles as the connection test (R-MOD-2).
      .get("/:id/models", validate("param", idParamSchema), async (c) => {
        const result = await listModels(c.req.valid("param").id);
        return result ? c.json(result) : c.json(notFound, 404);
      })
  );
}
