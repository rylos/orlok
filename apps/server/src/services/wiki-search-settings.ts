import type { WikiSearchSettings } from "@orlok/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";

const WIKI_SEARCH_SETTINGS_KEY = "wiki_search";

// On by default: without it, chatty messages bring pages that only share everyday words with them.
export async function getWikiSearchSettings(db: Db): Promise<WikiSearchSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, WIKI_SEARCH_SETTINGS_KEY))
    .limit(1);
  const value = row?.value as { queryRewrite?: unknown; queryProfileId?: unknown } | undefined;
  return {
    queryRewrite: typeof value?.queryRewrite === "boolean" ? value.queryRewrite : true,
    queryProfileId: typeof value?.queryProfileId === "string" ? value.queryProfileId : null,
  };
}

export async function saveWikiSearchSettings(db: Db, value: WikiSearchSettings) {
  await db
    .insert(settings)
    .values({ key: WIKI_SEARCH_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}
