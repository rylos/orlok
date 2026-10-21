import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings, telegramAccounts, telegramLinkTokens } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

// The installation's Telegram bot (R-CHAT-10): its token is encrypted like provider keys.
const BOT_KEY = "telegram_bot";
const OFFSET_KEY = "telegram_offset";

type StoredBot = { tokenEncrypted: string; username: string };

async function loadStored(db: Db): Promise<StoredBot | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, BOT_KEY));
  const value = row?.value as Partial<StoredBot> | undefined;
  return typeof value?.tokenEncrypted === "string" && typeof value.username === "string"
    ? { tokenEncrypted: value.tokenEncrypted, username: value.username }
    : null;
}

export async function getTelegramBot(db: Db, secretKey: Buffer) {
  const stored = await loadStored(db);
  return stored
    ? { token: decryptSecret(stored.tokenEncrypted, secretKey), username: stored.username }
    : null;
}

export async function getTelegramBotName(db: Db) {
  return (await loadStored(db))?.username ?? null;
}

export async function saveTelegramBot(
  db: Db,
  secretKey: Buffer,
  bot: { token: string; username: string },
) {
  const value: StoredBot = {
    tokenEncrypted: encryptSecret(bot.token, secretKey),
    username: bot.username,
  };
  await db
    .insert(settings)
    .values({ key: BOT_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  // A new bot starts from its own updates.
  await db.delete(settings).where(eq(settings.key, OFFSET_KEY));
}

// Removing the bot unlinks every account: their chats belonged to that bot.
export async function deleteTelegramBot(db: Db) {
  await db.delete(settings).where(eq(settings.key, BOT_KEY));
  await db.delete(settings).where(eq(settings.key, OFFSET_KEY));
  await db.delete(telegramAccounts);
  await db.delete(telegramLinkTokens);
}

export async function getOffset(db: Db) {
  const [row] = await db.select().from(settings).where(eq(settings.key, OFFSET_KEY));
  return typeof row?.value === "number" ? row.value : 0;
}

export async function setOffset(db: Db, offset: number) {
  await db
    .insert(settings)
    .values({ key: OFFSET_KEY, value: offset })
    .onConflictDoUpdate({ target: settings.key, set: { value: offset } });
}

// One-time link tokens: whoever opens the link from their Telegram becomes that person there, so
// they last 15 minutes, work once and only their hash is stored.
const LINK_TTL_MS = 15 * 60_000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createLinkToken(db: Db, userId: string, now = new Date()) {
  const token = randomBytes(24).toString("base64url");
  await db.delete(telegramLinkTokens).where(eq(telegramLinkTokens.userId, userId));
  await db.delete(telegramLinkTokens).where(lt(telegramLinkTokens.expiresAt, now));
  await db.insert(telegramLinkTokens).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + LINK_TTL_MS),
  });
  return token;
}

export async function consumeLinkToken(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .delete(telegramLinkTokens)
    .where(
      and(
        eq(telegramLinkTokens.tokenHash, hashToken(token)),
        gt(telegramLinkTokens.expiresAt, now),
      ),
    )
    .returning({ userId: telegramLinkTokens.userId });
  return row?.userId ?? null;
}
