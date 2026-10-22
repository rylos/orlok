import type {
  ActiveSession,
  LiveEvent,
  Me,
  NotificationSettings,
  TelegramLink,
} from "@orlok/shared";
import {
  commandTypeUpdateSchema,
  notificationSettingsSchema,
  passwordChangeSchema,
  preferencesSchema,
  pushEndpointSchema,
  pushSubscriptionSchema,
} from "@orlok/shared/schemas";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { currentUser, requireUser } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/password";
import { clearSessionCookie } from "../auth/sessions";
import { hashSessionToken } from "../auth/tokens";
import { pushSubscriptions, sessions, telegramAccounts, users } from "../db/schema";
import { errorBody } from "../lib/errors";
import { idParamSchema, validate } from "../lib/validation";
import {
  deleteApprovedType,
  findApprovedType,
  listApprovedTypes,
  setTypeDisabled,
} from "../ops/approved-types";
import { liveEvents } from "../services/live-events";
import { notifyPasswordChanged } from "../services/password-resets";
import { getVapidKeys } from "../services/push";
import { createLinkToken, getTelegramBotName } from "../telegram/settings";
import type { AppEnv, Deps } from "../types";

const sessionParamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, { error: "invalid_value" }),
});

export function meRoutes(deps: Deps) {
  const { db, config } = deps;
  async function telegramLink(userId: string): Promise<TelegramLink> {
    const botUsername = await getTelegramBotName(db);
    const [account] = await db
      .select({ username: telegramAccounts.username })
      .from(telegramAccounts)
      .where(eq(telegramAccounts.userId, userId));
    return {
      available: botUsername !== null,
      botUsername,
      linked: account !== undefined,
      username: account?.username ?? null,
    };
  }

  async function notificationSettings(userId: string): Promise<NotificationSettings> {
    const [row] = await db
      .select({
        email: users.notifyByEmail,
        push: users.notifyByPush,
        telegram: users.notifyByTelegram,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const [devices] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    const vapid = await getVapidKeys(db, config.secretKey, config.publicUrl);
    return {
      email: row?.email ?? true,
      push: row?.push ?? true,
      telegram: row?.telegram ?? true,
      vapidPublicKey: vapid.publicKey,
      devices: Number(devices?.count ?? 0),
    };
  }

  return (
    new Hono<AppEnv>()
      .use(requireUser)
      .get("/", (c) => c.json(currentUser(c)))
      // What changes for this person elsewhere, so open pages follow along (R-CHAT-13). A
      // comment every 25 seconds keeps proxies from closing a quiet stream.
      .get("/events", (c) => {
        const userId = currentUser(c).id;
        return streamSSE(c, async (stream) => {
          const queued: LiveEvent[] = [];
          let wake = () => {};
          const unsubscribe = liveEvents.subscribe(userId, (event) => {
            queued.push(event);
            wake();
          });
          let closed = false;
          stream.onAbort(() => {
            closed = true;
            wake();
          });
          try {
            await stream.writeSSE({ event: "ready", data: "{}" });
            while (!closed) {
              for (let event = queued.shift(); event && !closed; event = queued.shift()) {
                await stream.writeSSE({ data: JSON.stringify(event) });
              }
              if (closed) {
                break;
              }
              const timer = new Promise<"ping">((resolve) => {
                const id = setTimeout(() => resolve("ping"), 25_000);
                wake = () => {
                  clearTimeout(id);
                  resolve("ping");
                  wake = () => {};
                };
              });
              await timer;
              if (!closed && queued.length === 0) {
                await stream.write(": ping\n\n");
              }
            }
          } catch {
            // The page went away while writing: nothing else to do.
          } finally {
            unsubscribe();
          }
        });
      })
      .patch("/preferences", validate("json", preferencesSchema), async (c) => {
        const user = currentUser(c);
        const input = c.req.valid("json");
        const changes = {
          ...(input.themePreference ? { themePreference: input.themePreference } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
        };
        await db.update(users).set(changes).where(eq(users.id, user.id));
        const updated: Me = { ...user, ...changes };
        return c.json(updated);
      })
      // Changing one's own password signs out every other device (R-AUTH-6).
      .patch("/password", validate("json", passwordChangeSchema), async (c) => {
        const user = currentUser(c);
        const { currentPassword, newPassword } = c.req.valid("json");
        const [row] = await db
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);
        if (!row || !(await verifyPassword(row.passwordHash, currentPassword))) {
          return c.json(
            errorBody("invalid_credentials", "The current password is not correct"),
            401,
          );
        }
        await db
          .update(users)
          .set({ passwordHash: await hashPassword(newPassword) })
          .where(eq(users.id, user.id));
        const token = c.get("sessionToken");
        await db
          .delete(sessions)
          .where(
            token
              ? and(eq(sessions.userId, user.id), ne(sessions.id, hashSessionToken(token)))
              : eq(sessions.userId, user.id),
          );
        await notifyPasswordChanged(deps, user, "account");
        return c.body(null, 204);
      })
      // Notifications about approvals and finished interventions (R-CHAT-7).
      .get("/notifications", async (c) => c.json(await notificationSettings(currentUser(c).id)))
      .patch("/notifications", validate("json", notificationSettingsSchema), async (c) => {
        const user = currentUser(c);
        const input = c.req.valid("json");
        const changes = {
          ...(input.email === undefined ? {} : { notifyByEmail: input.email }),
          ...(input.push === undefined ? {} : { notifyByPush: input.push }),
          ...(input.telegram === undefined ? {} : { notifyByTelegram: input.telegram }),
        };
        if (Object.keys(changes).length > 0) {
          await db.update(users).set(changes).where(eq(users.id, user.id));
        }
        return c.json(await notificationSettings(user.id));
      })
      // Telegram (R-CHAT-10): a one-time link opens the bot and ties the chat to this person.
      .get("/telegram", async (c) => c.json(await telegramLink(currentUser(c).id)))
      .post("/telegram/link", async (c) => {
        const botUsername = await getTelegramBotName(db);
        if (!botUsername) {
          return c.json(errorBody("conflict", "No Telegram bot is configured"), 409);
        }
        const token = await createLinkToken(db, currentUser(c).id);
        return c.json({ url: `https://t.me/${botUsername}?start=${token}` });
      })
      .delete("/telegram", async (c) => {
        await db.delete(telegramAccounts).where(eq(telegramAccounts.userId, currentUser(c).id));
        return c.body(null, 204);
      })
      .post("/push-subscriptions", validate("json", pushSubscriptionSchema), async (c) => {
        const user = currentUser(c);
        const { endpoint, keys } = c.req.valid("json");
        await db
          .insert(pushSubscriptions)
          .values({
            userId: user.id,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            userAgent: c.req.header("user-agent") ?? null,
          })
          .onConflictDoUpdate({
            target: pushSubscriptions.endpoint,
            set: { userId: user.id, p256dh: keys.p256dh, auth: keys.auth },
          });
        return c.body(null, 204);
      })
      .delete("/push-subscriptions", validate("json", pushEndpointSchema), async (c) => {
        await db
          .delete(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.endpoint, c.req.valid("json").endpoint),
              eq(pushSubscriptions.userId, currentUser(c).id),
            ),
          );
        return c.body(null, 204);
      })
      // Devices and browsers signed in as the current person (R-AUTH-5).
      .get("/sessions", async (c) => {
        const user = currentUser(c);
        const token = c.get("sessionToken");
        const currentId = token ? hashSessionToken(token) : null;
        const rows = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
          .orderBy(desc(sessions.lastSeenAt));
        const list: ActiveSession[] = rows.map((row) => ({
          id: row.id,
          current: row.id === currentId,
          persistent: row.persistent,
          userAgent: row.userAgent,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        }));
        return c.json(list);
      })
      // Signs out every other device.
      .delete("/sessions", async (c) => {
        const user = currentUser(c);
        const token = c.get("sessionToken");
        await db
          .delete(sessions)
          .where(
            token
              ? and(eq(sessions.userId, user.id), ne(sessions.id, hashSessionToken(token)))
              : eq(sessions.userId, user.id),
          );
        return c.body(null, 204);
      })
      .delete("/sessions/:id", validate("param", sessionParamSchema), async (c) => {
        const user = currentUser(c);
        const { id } = c.req.valid("param");
        const [deleted] = await db
          .delete(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
          .returning({ id: sessions.id });
        if (!deleted) {
          return c.json(errorBody("not_found", "Session not found"), 404);
        }
        const token = c.get("sessionToken");
        if (token && hashSessionToken(token) === id) {
          clearSessionCookie(c);
        }
        return c.body(null, 204);
      })
      // Command types the person approved "always": theirs to review, turn off and take back.
      // One an administrator disabled stays as it is until an administrator enables it.
      .get("/command-types", async (c) => c.json(await listApprovedTypes(db, currentUser(c).id)))
      .patch(
        "/command-types/:id",
        validate("param", idParamSchema),
        validate("json", commandTypeUpdateSchema),
        async (c) => {
          const user = currentUser(c);
          const row = await findApprovedType(db, c.req.valid("param").id);
          if (!row || row.userId !== user.id) {
            return c.json(errorBody("not_found", "Command type not found"), 404);
          }
          if (row.disabledByAdmin) {
            return c.json(errorBody("conflict", "An administrator disabled this type"), 409);
          }
          const { disabled } = c.req.valid("json");
          return c.json(
            await setTypeDisabled(db, row, { disabled, byAdmin: false, actorUserId: user.id }),
          );
        },
      )
      .delete("/command-types/:id", validate("param", idParamSchema), async (c) => {
        const user = currentUser(c);
        const row = await findApprovedType(db, c.req.valid("param").id);
        if (!row || row.userId !== user.id) {
          return c.json(errorBody("not_found", "Command type not found"), 404);
        }
        if (row.disabledByAdmin) {
          return c.json(errorBody("conflict", "An administrator disabled this type"), 409);
        }
        await deleteApprovedType(db, row, user.id);
        return c.body(null, 204);
      })
  );
}
