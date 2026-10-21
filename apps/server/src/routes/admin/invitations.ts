import type { InvitationResult } from "@orlok/shared";
import { invitationCreateSchema } from "@orlok/shared/schemas";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import { generateSessionToken, hashSessionToken } from "../../auth/tokens";
import { invitationOffices, invitationProfiles, invitations, users } from "../../db/schema";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { getSetupStatus } from "../../services/installation";
import { invitationExpiry, invitationUrl, sendInvitationEmail } from "../../services/invitations";
import {
  invitationMemberships,
  invitationProfileIds,
  toInvitation,
  unknownOfficeIds,
  unknownProfileIds,
} from "../../services/people";
import type { AppEnv, Deps } from "../../types";

const notFound = errorBody("not_found", "Invitation not found");

// Invitations by email (R-ADM-4), administrators only.
export function invitationRoutes(deps: Deps) {
  const { db, config } = deps;

  return (
    new Hono<AppEnv>()
      .post("/", validate("json", invitationCreateSchema), async (c) => {
        const me = currentUser(c);
        const input = c.req.valid("json");

        const [existing] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);
        if (existing) {
          return c.json(
            errorBody("conflict", "A person with this email already exists", [
              { path: "email", code: "email_taken" },
            ]),
            409,
          );
        }
        // An administrator works in every office, so none are assigned.
        const memberships = input.role === "admin" ? [] : input.memberships;
        if (
          (
            await unknownOfficeIds(
              db,
              memberships.map((m) => m.officeId),
            )
          ).length > 0
        ) {
          return c.json(
            errorBody("validation_failed", "Unknown office", [
              { path: "memberships", code: "invalid_value" },
            ]),
            400,
          );
        }

        if ((await unknownProfileIds(db, input.profileIds)).length > 0) {
          return c.json(
            errorBody("validation_failed", "Unknown model profile", [
              { path: "profileIds", code: "invalid_value" },
            ]),
            400,
          );
        }

        const token = generateSessionToken();
        const expiresAt = invitationExpiry();
        const locale = input.locale ?? (await getSetupStatus(db)).defaultLocale;

        const invitation = await db.transaction(async (tx) => {
          // A new invitation replaces any pending one for the same address.
          await tx
            .update(invitations)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(invitations.email, input.email),
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
              ),
            );
          const [row] = await tx
            .insert(invitations)
            .values({
              email: input.email,
              displayName: input.displayName || null,
              role: input.role,
              locale,
              tokenHash: hashSessionToken(token),
              invitedById: me.id,
              expiresAt,
            })
            .returning();
          if (!row) {
            throw new Error("Invitation insert returned no row");
          }
          if (memberships.length > 0) {
            await tx
              .insert(invitationOffices)
              .values(memberships.map((membership) => ({ ...membership, invitationId: row.id })));
          }
          if (input.profileIds.length > 0) {
            await tx
              .insert(invitationProfiles)
              .values(input.profileIds.map((profileId) => ({ invitationId: row.id, profileId })));
          }
          return row;
        });

        const result: InvitationResult = {
          invitation: toInvitation(invitation, memberships, input.profileIds, me.displayName),
          inviteUrl: invitationUrl(config.publicUrl, token),
          email: await sendInvitationEmail(deps, {
            to: invitation.email,
            locale,
            inviterName: me.displayName,
            token,
            expiresAt,
          }),
        };
        return c.json(result, 201);
      })
      // Issues a new link (the previous one stops working) and sends the email again.
      .post("/:id/resend", validate("param", idParamSchema), async (c) => {
        const me = currentUser(c);
        const { id } = c.req.valid("param");
        const token = generateSessionToken();
        const expiresAt = invitationExpiry();

        const [invitation] = await db
          .update(invitations)
          .set({ tokenHash: hashSessionToken(token), expiresAt, invitedById: me.id })
          .where(
            and(
              eq(invitations.id, id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning();
        if (!invitation) {
          return c.json(notFound, 404);
        }

        const memberships = (await invitationMemberships(db, [id])).get(id) ?? [];
        const profileIds = (await invitationProfileIds(db, [id])).get(id) ?? [];
        const result: InvitationResult = {
          invitation: toInvitation(invitation, memberships, profileIds, me.displayName),
          inviteUrl: invitationUrl(config.publicUrl, token),
          email: await sendInvitationEmail(deps, {
            to: invitation.email,
            locale: invitation.locale,
            inviterName: me.displayName,
            token,
            expiresAt,
          }),
        };
        return c.json(result);
      })
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        const revoked = await db
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(invitations.id, id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning({ id: invitations.id });
        return revoked.length > 0 ? c.body(null, 204) : c.json(notFound, 404);
      })
  );
}
