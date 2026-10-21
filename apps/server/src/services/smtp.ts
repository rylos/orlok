import { isSmtpSecurity, type SmtpSettings } from "@orlok/shared";
import type { smtpSettingsSchema } from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { SmtpConnection } from "../mail";

// Stored in the settings table; the password is encrypted (R-SEC-2).
const SMTP_SETTINGS_KEY = "smtp";

type StoredSmtp = Omit<SmtpConnection, "password"> & { passwordEncrypted: string | null };

function parseStored(value: unknown): StoredSmtp | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.host !== "string" ||
    typeof v.port !== "number" ||
    !isSmtpSecurity(v.security) ||
    typeof v.fromAddress !== "string"
  ) {
    return null;
  }
  return {
    host: v.host,
    port: v.port,
    security: v.security,
    username: typeof v.username === "string" ? v.username : null,
    passwordEncrypted: typeof v.passwordEncrypted === "string" ? v.passwordEncrypted : null,
    fromAddress: v.fromAddress,
    fromName: typeof v.fromName === "string" ? v.fromName : null,
  };
}

async function loadStored(db: Db) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SMTP_SETTINGS_KEY))
    .limit(1);
  return parseStored(row?.value);
}

function toSettings(stored: StoredSmtp): SmtpSettings {
  const { passwordEncrypted, ...rest } = stored;
  return { ...rest, hasPassword: passwordEncrypted !== null };
}

export async function getSmtpSettings(db: Db) {
  const stored = await loadStored(db);
  return stored ? toSettings(stored) : null;
}

export async function getSmtpConnection(db: Db, secretKey: Buffer): Promise<SmtpConnection | null> {
  const stored = await loadStored(db);
  if (!stored) {
    return null;
  }
  const { passwordEncrypted, ...rest } = stored;
  return {
    ...rest,
    password: passwordEncrypted ? decryptSecret(passwordEncrypted, secretKey) : null,
  };
}

export async function saveSmtpSettings(
  db: Db,
  input: z.output<typeof smtpSettingsSchema>,
  secretKey: Buffer,
) {
  const current = await loadStored(db);
  const passwordEncrypted =
    input.password === undefined
      ? (current?.passwordEncrypted ?? null)
      : input.password
        ? encryptSecret(input.password, secretKey)
        : null;
  const value: StoredSmtp = {
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username || null,
    passwordEncrypted,
    fromAddress: input.fromAddress,
    fromName: input.fromName || null,
  };
  await db
    .insert(settings)
    .values({ key: SMTP_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return toSettings(value);
}
