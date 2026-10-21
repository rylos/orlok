import type { ModelProfile, ModelProvider } from "@orlok/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type ModelProfileRow,
  type ModelProviderRow,
  modelProfiles,
  modelProviders,
  profileGrants,
} from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import type { LlmClientFactory, ProviderConnection } from "../llm";
import { knownContextWindow } from "../llm/known-windows";

export function toProvider(row: ModelProviderRow): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeyEncrypted !== null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toProfile(row: ModelProfileRow): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    providerId: row.providerId,
    model: row.model,
    mode: row.mode,
    maxOutputTokens: row.maxOutputTokens,
    contextWindow: row.contextWindow,
    createdAt: row.createdAt.toISOString(),
  };
}

export function connectionFor(row: ModelProviderRow, secretKey: Buffer): ProviderConnection {
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    apiKey: row.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted, secretKey) : null,
  };
}

export async function findProvider(db: Db, id: string) {
  const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  return row ?? null;
}

export async function findProfileWithProvider(db: Db, id: string) {
  const [row] = await db
    .select({ profile: modelProfiles, provider: modelProviders })
    .from(modelProfiles)
    .innerJoin(modelProviders, eq(modelProfiles.providerId, modelProviders.id))
    .where(eq(modelProfiles.id, id))
    .limit(1);
  return row ?? null;
}

export async function findProfile(db: Db, id: string) {
  const [row] = await db.select().from(modelProfiles).where(eq(modelProfiles.id, id)).limit(1);
  return row ?? null;
}

// Limits of a model as published by its provider, or null when unknown or unreachable. Anthropic
// publishes both, Ollama the context window, the OpenAI API neither.
export async function findModelLimits(
  llm: LlmClientFactory,
  provider: ModelProviderRow,
  secretKey: Buffer,
  modelId: string,
) {
  try {
    const models = await llm(connectionFor(provider, secretKey)).listModels();
    return models.find((model) => model.id === modelId) ?? null;
  } catch {
    return null;
  }
}

// Profiles saved before the context window existed, or whose provider was unreachable when they
// were saved, get it here: once at start, from the provider when it publishes one and from the
// model's family when it does not (R-MOD-6). The rest stay empty and are typed in by an
// administrator.
export async function backfillContextWindows(deps: {
  db: Db;
  llm: LlmClientFactory;
  config: { secretKey: Buffer };
}) {
  const rows = await deps.db
    .select({ profile: modelProfiles, provider: modelProviders })
    .from(modelProfiles)
    .innerJoin(modelProviders, eq(modelProfiles.providerId, modelProviders.id))
    .where(isNull(modelProfiles.contextWindow));
  for (const { profile, provider } of rows) {
    const limits = await findModelLimits(deps.llm, provider, deps.config.secretKey, profile.model);
    const published = limits?.contextWindow ?? null;
    const contextWindow = published ?? knownContextWindow(profile.model);
    if (contextWindow) {
      await deps.db
        .update(modelProfiles)
        .set({ contextWindow })
        .where(eq(modelProfiles.id, profile.id));
      console.info(
        `Context window of "${profile.name}": ${contextWindow} tokens, ${published ? "published by the provider" : `known for ${profile.model}`}`,
      );
    }
  }
}

// Model used by a colleague: its own profile, as long as its owner is still granted it. Null when
// it has none (R-MOD-2: no default) or the profile was taken away from its owner.
export async function resolveColleagueModel(
  db: Db,
  colleague: { userId: string; profileId: string | null },
) {
  if (!colleague.profileId) {
    return null;
  }
  const [row] = await db
    .select({ profile: modelProfiles, provider: modelProviders })
    .from(modelProfiles)
    .innerJoin(modelProviders, eq(modelProfiles.providerId, modelProviders.id))
    .innerJoin(
      profileGrants,
      and(
        eq(profileGrants.profileId, modelProfiles.id),
        eq(profileGrants.userId, colleague.userId),
      ),
    )
    .where(eq(modelProfiles.id, colleague.profileId))
    .limit(1);
  return row ?? null;
}

// Profiles a person may give their colleagues (R-MOD-2).
export async function grantedProfiles(db: Db, userId: string) {
  return db
    .select({ profile: modelProfiles })
    .from(profileGrants)
    .innerJoin(modelProfiles, eq(profileGrants.profileId, modelProfiles.id))
    .where(eq(profileGrants.userId, userId))
    .orderBy(asc(modelProfiles.name))
    .then((rows) => rows.map((row) => row.profile));
}
