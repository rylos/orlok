import type { ExecMode } from "@orlok/shared";
import { profileCreateSchema, profileUpdateSchema } from "@orlok/shared/schemas";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { type ModelProviderRow, modelProfiles, profileGrants } from "../../db/schema";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { knownContextWindow } from "../../llm/known-windows";
import { getDocumentSettings } from "../../services/document-settings";
import { findModelLimits, findProfile, findProvider, toProfile } from "../../services/models";
import { getWikiSearchSettings } from "../../services/wiki-search-settings";
import type { AppEnv, Deps } from "../../types";

async function nameTaken(db: Db, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: modelProfiles.id })
    .from(modelProfiles)
    .where(
      exceptId
        ? and(eq(modelProfiles.name, name), ne(modelProfiles.id, exceptId))
        : eq(modelProfiles.name, name),
    )
    .limit(1);
  return row !== undefined;
}

// One profile per model and mode (R-MOD-2): two would be the same choice under two names.
async function combinationTaken(db: Db, providerId: string, model: string, mode: ExecMode) {
  const [row] = await db
    .select({ id: modelProfiles.id })
    .from(modelProfiles)
    .where(
      and(
        eq(modelProfiles.providerId, providerId),
        eq(modelProfiles.model, model),
        eq(modelProfiles.mode, mode),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// A profile still worked with: a person was granted it, documents are described with it, or the
// wiki is searched with it.
// Colleagues do not count: they belong to people, who no longer hold the profile once nobody is
// granted it, and those still on it ask their owner for another one (R-MOD-2).
async function profileInUse(db: Db, id: string) {
  const [granted] = await db
    .select({ total: count() })
    .from(profileGrants)
    .where(eq(profileGrants.profileId, id));
  const { visionProfileId } = await getDocumentSettings(db);
  const { queryProfileId } = await getWikiSearchSettings(db);
  return (granted?.total ?? 0) > 0 || visionProfileId === id || queryProfileId === id;
}

const nameConflict = errorBody("conflict", "A profile with this name already exists");
const combinationConflict = errorBody(
  "conflict",
  "A profile with this model and mode already exists",
  [{ path: "mode", code: "profile_exists" }],
);
const inUse = errorBody(
  "profile_in_use",
  "The profile is granted to a person, used for documents or for searching the wiki",
);
const notFound = errorBody("not_found", "Profile not found");
const unknownProvider = errorBody("validation_failed", "Unknown provider", [
  { path: "providerId", code: "invalid_value" },
]);

// Model profiles (R-MOD-2), administrators only.
export function profileRoutes({ db, config, llm }: Deps) {
  // Rejects output limits above what the provider publishes for the model; unknown limits pass.
  // The context window fills the field the administrator left empty: what the provider publishes
  // first, then what the model's own family is known for, so the only profiles left without one
  // are those running a model nobody here can vouch for.
  async function checkLimits(
    provider: ModelProviderRow,
    model: string,
    maxOutputTokens: number,
  ): Promise<{ error?: ReturnType<typeof errorBody>; contextWindow: number | null }> {
    const limits = await findModelLimits(llm, provider, config.secretKey, model);
    const contextWindow = limits?.contextWindow ?? knownContextWindow(model);
    const max = limits?.maxOutputTokens ?? null;
    return max !== null && maxOutputTokens > max
      ? {
          contextWindow,
          error: errorBody("validation_failed", `The model allows at most ${max} output tokens`, [
            { path: "maxOutputTokens", code: "exceeds_model_limit", params: { max } },
          ]),
        }
      : { contextWindow };
  }

  return (
    new Hono<AppEnv>()
      .get("/", async (c) => {
        const rows = await db.select().from(modelProfiles).orderBy(asc(modelProfiles.name));
        return c.json(rows.map(toProfile));
      })
      .post("/", validate("json", profileCreateSchema), async (c) => {
        const input = c.req.valid("json");
        const provider = await findProvider(db, input.providerId);
        if (!provider) {
          return c.json(unknownProvider, 400);
        }
        if (await nameTaken(db, input.name)) {
          return c.json(nameConflict, 409);
        }
        if (await combinationTaken(db, input.providerId, input.model, input.mode)) {
          return c.json(combinationConflict, 409);
        }
        const limits = await checkLimits(provider, input.model, input.maxOutputTokens);
        if (limits.error) {
          return c.json(limits.error, 400);
        }
        const [row] = await db
          .insert(modelProfiles)
          .values({ ...input, contextWindow: input.contextWindow ?? limits.contextWindow })
          .returning();
        if (!row) {
          throw new Error("Profile insert returned no row");
        }
        return c.json(toProfile(row), 201);
      })
      // Only the name changes: the model and the mode are what the profile is (R-MOD-2).
      .patch(
        "/:id",
        validate("param", idParamSchema),
        validate("json", profileUpdateSchema),
        async (c) => {
          const { id } = c.req.valid("param");
          const { name } = c.req.valid("json");
          if (!(await findProfile(db, id))) {
            return c.json(notFound, 404);
          }
          if (await nameTaken(db, name, id)) {
            return c.json(nameConflict, 409);
          }
          const [row] = await db
            .update(modelProfiles)
            .set({ name })
            .where(eq(modelProfiles.id, id))
            .returning();
          return row ? c.json(toProfile(row)) : c.json(notFound, 404);
        },
      )
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        if (await profileInUse(db, id)) {
          return c.json(inUse, 409);
        }
        const deleted = await db
          .delete(modelProfiles)
          .where(eq(modelProfiles.id, id))
          .returning({ id: modelProfiles.id });
        return deleted.length > 0 ? c.body(null, 204) : c.json(notFound, 404);
      })
  );
}
