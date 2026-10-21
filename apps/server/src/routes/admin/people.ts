import type { PeopleOverview } from "@orlok/shared";
import { commandTypeUpdateSchema, personUpdateSchema } from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { currentUser } from "../../auth/middleware";
import { sessions, users } from "../../db/schema";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { findApprovedType, listApprovedTypes, setTypeDisabled } from "../../ops/approved-types";
import { waitingChanged } from "../../ops/jobs";
import { deleteCredentialsOf } from "../../ops/vault";
import { cancelWaitingApprovals, colleaguesWithoutGrant } from "../../services/colleagues";
import {
  findPerson,
  listPendingInvitations,
  listPeople,
  otherActiveAdminCount,
  replaceGrants,
  replaceMemberships,
  unknownOfficeIds,
  unknownProfileIds,
} from "../../services/people";
import type { AppEnv, Deps } from "../../types";

const personTypeParamSchema = z.object({
  id: z.uuid({ error: "invalid_value" }),
  typeId: z.uuid({ error: "invalid_value" }),
});

// People, their office memberships and granted model profiles (R-ADM-4, R-MOD-2),
// administrators only. Disabling someone deletes their credentials (R-OPS-3). The command types
// each person approved "always" are seen here, and an administrator may turn them off (R-OPS-4).
export function peopleRoutes({ db }: Deps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const overview: PeopleOverview = {
        people: await listPeople(db),
        invitations: await listPendingInvitations(db),
      };
      return c.json(overview);
    })
    .patch(
      "/:id",
      validate("param", idParamSchema),
      validate("json", personUpdateSchema),
      async (c) => {
        const me = currentUser(c);
        const { id } = c.req.valid("param");
        const input = c.req.valid("json");

        const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!target) {
          return c.json(errorBody("not_found", "Person not found"), 404);
        }

        const demoting = input.role === "member" && target.role === "admin";
        const disabling = input.disabled === true && target.disabledAt === null;
        if (id === me.id && (demoting || disabling)) {
          return c.json(
            errorBody("self_change_not_allowed", "You cannot demote or disable yourself"),
            409,
          );
        }
        if (
          (demoting || disabling) &&
          target.role === "admin" &&
          (await otherActiveAdminCount(db, id)) === 0
        ) {
          return c.json(
            errorBody("last_admin", "At least one active administrator is required"),
            409,
          );
        }
        // An administrator works in every office: becoming one, or saving one, leaves none assigned.
        const memberships = (input.role ?? target.role) === "admin" ? [] : input.memberships;
        if (
          memberships &&
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

        if (input.profileIds && (await unknownProfileIds(db, input.profileIds)).length > 0) {
          return c.json(
            errorBody("validation_failed", "Unknown model profile", [
              { path: "profileIds", code: "invalid_value" },
            ]),
            400,
          );
        }

        // Told only once the transaction is stored, or a page could read the requests as still
        // waiting and never hear again.
        let cancelled: Awaited<ReturnType<typeof cancelWaitingApprovals>> = [];
        await db.transaction(async (tx) => {
          const changes = {
            ...(input.role ? { role: input.role } : {}),
            ...(input.disabled === undefined
              ? {}
              : { disabledAt: input.disabled ? (target.disabledAt ?? new Date()) : null }),
          };
          if (Object.keys(changes).length > 0) {
            await tx.update(users).set(changes).where(eq(users.id, id));
          }
          if (memberships) {
            await replaceMemberships(tx, id, memberships);
          }
          if (input.profileIds) {
            await replaceGrants(tx, id, input.profileIds);
            cancelled = await cancelWaitingApprovals(
              tx,
              await colleaguesWithoutGrant(tx, id),
              "profile_changed",
            );
          }
          if (disabling) {
            await tx.delete(sessions).where(eq(sessions.userId, id));
            // Nobody works with them any more, so nothing of theirs is kept to act with.
            await deleteCredentialsOf(tx, id, me.id);
          }
        });
        waitingChanged(cancelled);

        return c.json(await findPerson(db, id));
      },
    )
    .get("/:id/command-types", validate("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      if (!(await findPerson(db, id))) {
        return c.json(errorBody("not_found", "Person not found"), 404);
      }
      return c.json(await listApprovedTypes(db, id));
    })
    .patch(
      "/:id/command-types/:typeId",
      validate("param", personTypeParamSchema),
      validate("json", commandTypeUpdateSchema),
      async (c) => {
        const { id, typeId } = c.req.valid("param");
        const row = await findApprovedType(db, typeId);
        if (!row || row.userId !== id) {
          return c.json(errorBody("not_found", "Command type not found"), 404);
        }
        const { disabled } = c.req.valid("json");
        return c.json(
          await setTypeDisabled(db, row, {
            disabled,
            byAdmin: true,
            actorUserId: currentUser(c).id,
          }),
        );
      },
    );
}
