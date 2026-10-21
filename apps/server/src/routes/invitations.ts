import type { InvitationPreview } from "@orlok/shared";
import { invitationAcceptSchema, invitationTokenParamSchema } from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { hashPassword } from "../auth/password";
import { createSession, setSessionCookie, toMe } from "../auth/sessions";
import {
  invitationOffices,
  invitationProfiles,
  invitations,
  officeMembers,
  profileGrants,
  users,
} from "../db/schema";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import { getSetupStatus } from "../services/installation";
import { findUsableInvitation } from "../services/invitations";
import type { AppEnv, Deps } from "../types";

const invalid = errorBody("invitation_invalid", "The invitation is invalid, used or expired");

// Public side of invitations: preview and acceptance with account creation (R-ADM-4).
export function publicInvitationRoutes({ db, config }: Deps) {
  return new Hono<AppEnv>()
    .get("/:token", validate("param", invitationTokenParamSchema), async (c) => {
      const invitation = await findUsableInvitation(db, c.req.valid("param").token);
      if (!invitation) {
        return c.json(invalid, 404);
      }
      const [inviter] = invitation.invitedById
        ? await db
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, invitation.invitedById))
            .limit(1)
        : [];
      const preview: InvitationPreview = {
        email: invitation.email,
        displayName: invitation.displayName,
        companyName: (await getSetupStatus(db)).companyName,
        invitedByName: inviter?.displayName ?? null,
        locale: invitation.locale,
      };
      return c.json(preview);
    })
    .post(
      "/:token/accept",
      validate("param", invitationTokenParamSchema),
      validate("json", invitationAcceptSchema),
      async (c) => {
        const invitation = await findUsableInvitation(db, c.req.valid("param").token);
        if (!invitation) {
          return c.json(invalid, 404);
        }
        const input = c.req.valid("json");
        const passwordHash = await hashPassword(input.password);

        const user = await db.transaction(async (tx) => {
          const [existing] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, invitation.email))
            .limit(1);
          if (existing) {
            return null;
          }
          const [created] = await tx
            .insert(users)
            .values({
              email: invitation.email,
              displayName: input.displayName,
              passwordHash,
              role: invitation.role,
              locale: invitation.locale,
            })
            .returning();
          if (!created) {
            throw new Error("User insert returned no row");
          }
          const memberships = await tx
            .select({ officeId: invitationOffices.officeId, role: invitationOffices.role })
            .from(invitationOffices)
            .where(eq(invitationOffices.invitationId, invitation.id));
          // Invitations sent before 2026-10-06 could give an administrator offices too.
          if (memberships.length > 0 && created.role !== "admin") {
            await tx
              .insert(officeMembers)
              .values(memberships.map((membership) => ({ ...membership, userId: created.id })));
          }
          const grants = await tx
            .select({ profileId: invitationProfiles.profileId })
            .from(invitationProfiles)
            .where(eq(invitationProfiles.invitationId, invitation.id));
          if (grants.length > 0) {
            await tx
              .insert(profileGrants)
              .values(grants.map((grant) => ({ ...grant, userId: created.id })));
          }
          await tx
            .update(invitations)
            .set({ acceptedAt: new Date() })
            .where(eq(invitations.id, invitation.id));
          return created;
        });

        if (!user) {
          return c.json(
            errorBody("conflict", "A person with this email already exists", [
              { path: "email", code: "email_taken" },
            ]),
            409,
          );
        }

        const { token, session } = await createSession(db, {
          userId: user.id,
          persistent: true,
          userAgent: c.req.header("user-agent"),
        });
        setSessionCookie(c, token, session, config.secureCookies);
        return c.json(toMe(user), 201);
      },
    );
}
