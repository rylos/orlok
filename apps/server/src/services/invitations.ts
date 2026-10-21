import { INVITATION_TTL_DAYS, type InvitationEmailStatus, type Locale } from "@orlok/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashSessionToken } from "../auth/tokens";
import type { Db } from "../db/client";
import { invitations } from "../db/schema";
import { invitationEmail } from "../mail";
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
  { db, config, mail }: Deps,
  params: {
    to: string;
    locale: Locale;
    inviterName: string | null;
    token: string;
    expiresAt: Date;
  },
): Promise<InvitationEmailStatus> {
  const connection = await getSmtpConnection(db, config.secretKey);
  if (!connection) {
    return { sent: false, reason: "not_configured", message: null };
  }
  try {
    const email = invitationEmail({
      locale: params.locale,
      companyName: (await getSetupStatus(db)).companyName,
      inviterName: params.inviterName,
      inviteUrl: invitationUrl(config.publicUrl, params.token),
      expiresAt: params.expiresAt,
    });
    await mail(connection).send({ to: params.to, ...email });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: "failed",
      message: error instanceof Error ? error.message : "Unknown mail error",
    };
  }
}
