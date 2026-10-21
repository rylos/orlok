import type { DocumentSettings } from "@orlok/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";

const DOCUMENT_SETTINGS_KEY = "documents";

export async function getDocumentSettings(db: Db): Promise<DocumentSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, DOCUMENT_SETTINGS_KEY))
    .limit(1);
  const value = row?.value as { visionProfileId?: unknown } | undefined;
  return {
    visionProfileId: typeof value?.visionProfileId === "string" ? value.visionProfileId : null,
  };
}

export async function saveDocumentSettings(db: Db, value: DocumentSettings) {
  await db
    .insert(settings)
    .values({ key: DOCUMENT_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}
