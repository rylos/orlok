import { DEFAULT_LOCALE, isLocale, type SetupStatus } from "@orlok/shared";
import { count, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings, users } from "../db/schema";

export const COMPANY_NAME_KEY = "company.name";
// Installation default language (R-I18N-3).
export const DEFAULT_LOCALE_KEY = "installation.default_locale";

// Arbitrary advisory lock id that serializes first-run setup.
export const SETUP_LOCK_ID = 7_314_001;

async function getSetting(db: Db, key: string) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value;
}

export async function getSetupStatus(db: Db): Promise<Omit<SetupStatus, "version">> {
  const [row] = await db.select({ total: count() }).from(users);
  const companyName = await getSetting(db, COMPANY_NAME_KEY);
  const defaultLocale = await getSetting(db, DEFAULT_LOCALE_KEY);
  return {
    needsSetup: (row?.total ?? 0) === 0,
    companyName: typeof companyName === "string" ? companyName : null,
    defaultLocale: isLocale(defaultLocale) ? defaultLocale : DEFAULT_LOCALE,
  };
}
