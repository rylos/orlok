import { randomInt } from "node:crypto";
import { type Locale, PASSWORD_RESET_TTL_HOURS, type PasswordResetResult } from "@orlok/shared";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { generateSessionToken, hashSessionToken } from "../auth/tokens";
import type { Db } from "../db/client";
import { passwordResets, sessions, type UserRow, users } from "../db/schema";
import { type PasswordChange, passwordChangedEmail, passwordResetEmail } from "../mail";
import { audit } from "../ops/audit";
import type { Deps } from "../types";
import { deliverLinkEmail } from "./invitations";
import type { DbExecutor } from "./wiki";

// Passwords reset by an administrator, from the app or from the server (R-AUTH-7). Nobody ever
// learns a password: the app sends a one-time link, the server command prints a new password
// once to whoever runs it. Either way every session of the person ends.

const HOUR_MS = 60 * 60 * 1000;

export function passwordResetUrl(publicUrl: string, token: string) {
  return `${publicUrl}/reset-password/${token}`;
}

// A new link replaces any previous one and ends the person's sessions, so the old password stops
// mattering at once. An administrator resetting their own keeps the session they are using.
export async function createPasswordReset(
  deps: Deps,
  params: {
    person: UserRow;
    admin: { id: string; displayName: string };
    keepSessionToken?: string;
  },
): Promise<PasswordResetResult> {
  const { db, config } = deps;
  const { person, admin, keepSessionToken } = params;
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * HOUR_MS);

  await db.transaction(async (tx) => {
    await tx.delete(passwordResets).where(eq(passwordResets.userId, person.id));
    await tx.insert(passwordResets).values({
      userId: person.id,
      tokenHash: hashSessionToken(token),
      createdById: admin.id,
      expiresAt,
    });
    await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, person.id),
          keepSessionToken ? ne(sessions.id, hashSessionToken(keepSessionToken)) : undefined,
        ),
      );
    await audit(tx, {
      officeId: null,
      actor: { userId: admin.id },
      action: "person.password_reset_link",
      target: person.email,
    });
  });

  const resetUrl = passwordResetUrl(config.publicUrl, token);
  return {
    person: { id: person.id, email: person.email, displayName: person.displayName },
    resetUrl,
    expiresAt: expiresAt.toISOString(),
    email: await deliverLinkEmail(deps, person.email, (companyName) =>
      passwordResetEmail({
        locale: person.locale,
        companyName,
        adminName: admin.displayName,
        resetUrl,
        hours: PASSWORD_RESET_TTL_HOURS,
      }),
    ),
  };
}

// The person a link is still good for: not used, replaced or expired, and not disabled since.
export async function findPasswordResetUser(db: Db, token: string) {
  const [row] = await db
    .select({ user: users })
    .from(passwordResets)
    .innerJoin(users, eq(passwordResets.userId, users.id))
    .where(
      and(
        eq(passwordResets.tokenHash, hashSessionToken(token)),
        gt(passwordResets.expiresAt, new Date()),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return row?.user ?? null;
}

// Sets the password chosen from a link; null when the link is no longer good. The link and any
// session opened meanwhile are gone afterwards.
export async function completePasswordReset(db: Db, token: string, password: string) {
  const user = await findPasswordResetUser(db, token);
  if (!user) {
    return null;
  }
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    // Taken by whoever deletes it first: two submissions of the same link set one password.
    const taken = await tx
      .delete(passwordResets)
      .where(eq(passwordResets.tokenHash, hashSessionToken(token)))
      .returning({ id: passwordResets.id });
    if (taken.length === 0) {
      return null;
    }
    await setPassword(tx, user.id, passwordHash);
    await audit(tx, {
      officeId: null,
      actor: { userId: user.id },
      action: "person.password_reset",
      target: user.email,
    });
    return user;
  });
}

export type ServerResetOutcome =
  | { ok: true; user: UserRow; password: string }
  | { ok: false; reason: "not_found" | "disabled" };

// The way back in when no administrator can sign in: run on the server, so whoever runs it can
// already reach the database. A disabled person stays out; an administrator enables them.
export async function resetPasswordFromServer(db: Db, email: string): Promise<ServerResetOutcome> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .limit(1);
  if (!user) {
    return { ok: false, reason: "not_found" };
  }
  if (user.disabledAt) {
    return { ok: false, reason: "disabled" };
  }
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await setPassword(tx, user.id, passwordHash);
    await audit(tx, {
      officeId: null,
      actor: null,
      action: "person.password_reset_server",
      target: user.email,
    });
  });
  return { ok: true, user, password };
}

// Tells the person their password changed, however it happened. Never thrown: the change stands
// whether or not the email leaves.
export function notifyPasswordChanged(
  deps: Pick<Deps, "db" | "config" | "mail">,
  person: { email: string; locale: Locale },
  how: PasswordChange,
) {
  return deliverLinkEmail(deps, person.email, (companyName) =>
    passwordChangedEmail({ locale: person.locale, companyName, email: person.email, how }),
  );
}

async function setPassword(tx: DbExecutor, userId: string, passwordHash: string) {
  await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
}

// Three groups of six letters and digits, without the ones easily mistaken (0/O, 1/l/I): about
// 104 bits, readable aloud and typed once.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword() {
  const group = () =>
    Array.from({ length: 6 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join(
      "",
    );
  return [group(), group(), group()].join("-");
}
