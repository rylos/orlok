import type { Me } from "@orlok/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client";
import { sessions, type UserRow, users } from "../db/schema";
import { generateSessionToken, hashSessionToken } from "./tokens";

export const SESSION_COOKIE = "orlok_session";

const HOUR_MS = 60 * 60 * 1000;
// "Remember me": 30-day session renewed with use. Otherwise 12 hours and a session cookie.
export const PERSISTENT_SESSION_TTL_MS = 30 * 24 * HOUR_MS;
export const TRANSIENT_SESSION_TTL_MS = 12 * HOUR_MS;
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

export type SessionInfo = {
  expiresAt: Date;
  persistent: boolean;
};

function lifetime(persistent: boolean) {
  return persistent ? PERSISTENT_SESSION_TTL_MS : TRANSIENT_SESSION_TTL_MS;
}

export function toMe(user: UserRow): Me {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    themePreference: user.themePreference,
    locale: user.locale,
  };
}

export async function createSession(
  db: Db,
  input: { userId: string; persistent: boolean; userAgent?: string | null },
) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + lifetime(input.persistent));
  await db.insert(sessions).values({
    id: hashSessionToken(token),
    userId: input.userId,
    persistent: input.persistent,
    userAgent: input.userAgent ?? null,
    expiresAt,
  });
  return { token, session: { expiresAt, persistent: input.persistent } };
}

export async function validateSession(db: Db, token: string) {
  const id = hashSessionToken(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id))
    .limit(1);

  if (!row) {
    return null;
  }

  const now = Date.now();
  // Sessions of disabled people end immediately.
  if (row.user.disabledAt || row.session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  // Sliding session: renewed once half of its lifetime has elapsed. The last use is recorded at
  // most every few minutes so the list of active sessions stays meaningful (R-AUTH-5).
  const ttl = lifetime(row.session.persistent);
  let expiresAt = row.session.expiresAt;
  const renewed = expiresAt.getTime() - now < ttl / 2;
  if (renewed) {
    expiresAt = new Date(now + ttl);
  }
  if (renewed || now - row.session.lastSeenAt.getTime() > LAST_SEEN_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ expiresAt, lastSeenAt: new Date(now) })
      .where(eq(sessions.id, id));
  }

  return {
    user: toMe(row.user),
    session: { expiresAt, persistent: row.session.persistent },
    renewed,
  };
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
}

export function setSessionCookie(c: Context, token: string, session: SessionInfo, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(session.persistent ? { expires: session.expiresAt } : {}),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
