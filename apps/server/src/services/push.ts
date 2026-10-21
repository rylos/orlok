import { eq } from "drizzle-orm";
import webPush from "web-push";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

// Web push delivery (R-CHAT-7).

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
export type VapidKeys = { subject: string; publicKey: string; privateKey: string };
// Throws an error with a numeric statusCode when the push service refuses the message.
export type PushSender = (target: PushTarget, payload: string, vapid: VapidKeys) => Promise<void>;

export const sendWebPush: PushSender = async (target, payload, vapid) => {
  await webPush.sendNotification(target, payload, {
    vapidDetails: vapid,
    TTL: 6 * 60 * 60,
    urgency: "high",
  });
};

const VAPID_SETTINGS_KEY = "web_push";

// Generated on first use and then kept: new keys would invalidate every subscription.
export async function getVapidKeys(
  db: Db,
  secretKey: Buffer,
  publicUrl: string,
): Promise<VapidKeys> {
  // The VAPID subject must be an https: or mailto: URL.
  const subject = publicUrl.startsWith("https://")
    ? publicUrl
    : "mailto:notifications@orlok.invalid";
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, VAPID_SETTINGS_KEY))
    .limit(1);
  const value = row?.value as { publicKey?: unknown; privateKeyEncrypted?: unknown } | undefined;
  if (typeof value?.publicKey === "string" && typeof value.privateKeyEncrypted === "string") {
    return {
      subject,
      publicKey: value.publicKey,
      privateKey: decryptSecret(value.privateKeyEncrypted, secretKey),
    };
  }
  const generated = webPush.generateVAPIDKeys();
  const [stored] = await db
    .insert(settings)
    .values({
      key: VAPID_SETTINGS_KEY,
      value: {
        publicKey: generated.publicKey,
        privateKeyEncrypted: encryptSecret(generated.privateKey, secretKey),
      },
    })
    .onConflictDoNothing()
    .returning({ key: settings.key });
  // Another request stored its keys first: use those.
  return stored ? { subject, ...generated } : getVapidKeys(db, secretKey, publicUrl);
}
