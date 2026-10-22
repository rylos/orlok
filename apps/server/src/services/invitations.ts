import { INVITATION_TTL_DAYS, type InvitationEmailStatus, type Locale } from "@orlok/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashSessionToken } from "../auth/tokens";
import type { Db } from "../db/client";
import { invitations } from "../db/schema";
import { type Email, invitationEmail } from "../mail";
import type { Deps } from "../types";
import { getSetupStatus } from "./installation";
import { getSmtpConnection } from "./smtp";

const DAY_MS = 24 * 60 * 60 * 1000;

export function invitationExpiry() {
  return new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);
}

export function invitationUrl(publicUrl: string, token: string) {
  return `${publicUrl}/invite/${token}`;
}

// An invitation that can still be accepted.
export async function findUsableInvitation(db: Db, token: string) {
  const [row] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashSessionToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Sending failures do not cancel the invitation: the administrator can share the link.
export async function sendInvitationEmail(
  deps: Deps,
  params: {
    to: string;
    locale: Locale;
    inviterName: string | null;
    token: string;
    expiresAt: Date;
  },
): Promise<InvitationEmailStatus> {
  return deliverLinkEmail(deps, params.to, (companyName) =>
    invitationEmail({
      locale: params.locale,
      companyName,
      inviterName: params.inviterName,
      inviteUrl: invitationUrl(deps.config.publicUrl, params.token),
      expiresAt: params.expiresAt,
    }),
  );
}

// An email carrying a link the administrator also receives (invitations, password resets), or a
// notice nothing depends on (password changed): a failure is reported, never thrown, so the link
// can be shared by hand and the change it tells about still happens.
export async function deliverLinkEmail(
  { db, config, mail }: Pick<Deps, "db" | "config" | "mail">,
  to: string,
  compose: (companyName: string | null) => Email,
): Promise<InvitationEmailStatus> {
  const connection = await getSmtpConnection(db, config.secretKey);
  if (!connection) {
    return { sent: false, reason: "not_configured", message: null };
  }
  try {
    const email = compose((await getSetupStatus(db)).companyName);
    await mail(connection).send({ to, ...email });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: "failed",
      message: error instanceof Error ? error.message : "Unknown mail error",
    };
  }
}
