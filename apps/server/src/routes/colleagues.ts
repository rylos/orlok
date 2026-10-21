import { colleagueCreateSchema, colleagueUpdateSchema } from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { currentUser, requireUser } from "../auth/middleware";
import { colleagues } from "../db/schema";
import { errorBody } from "../lib/errors";
import { idParamSchema, validate } from "../lib/validation";
import { waitingChanged } from "../ops/jobs";
import {
  cancelWaitingApprovals,
  colleagueNameTaken,
  deleteColleague,
  findOwnColleague,
  profileGranted,
  toColleague,
} from "../services/colleagues";
import { grantedProfiles, toProfile } from "../services/models";
import { canAccessOffice } from "../services/offices";
import type { AppEnv, Deps } from "../types";

const colleagueNotFound = errorBody("not_found", "Colleague not found");
const officeNotFound = errorBody("not_found", "Office not found");
const nameTaken = errorBody("conflict", "You already have a colleague with this name here", [
  { path: "name", code: "name_taken" },
]);
const notGranted = errorBody("validation_failed", "This profile is not granted to you", [
  { path: "profileId", code: "not_granted" },
]);

// A person's own colleagues (R-ADM-3): created in one of their offices with one of the profiles
// they are granted (R-MOD-2), seen and changed by nobody else.
export function colleagueRoutes({ db }: Deps) {
  return (
    new Hono<AppEnv>()
      .use(requireUser)
      // The profiles the signed-in person may give their colleagues.
      .get("/profiles", async (c) =>
        c.json((await grantedProfiles(db, currentUser(c).id)).map(toProfile)),
      )
      .post("/", validate("json", colleagueCreateSchema), async (c) => {
        const user = currentUser(c);
        const { officeId, ...input } = c.req.valid("json");
        if (!(await canAccessOffice(db, user, officeId))) {
          return c.json(officeNotFound, 404);
        }
        if (!(await profileGranted(db, user.id, input.profileId))) {
          return c.json(notGranted, 400);
        }
        if (await colleagueNameTaken(db, { userId: user.id, officeId }, input.name)) {
          return c.json(nameTaken, 409);
        }
        const [row] = await db
          .insert(colleagues)
          .values({ ...input, officeId, userId: user.id })
          .returning();
        if (!row) {
          throw new Error("Colleague insert returned no row");
        }
        return c.json(toColleague(row, false), 201);
      })
      .get("/:id", validate("param", idParamSchema), async (c) => {
        const user = currentUser(c);
        const found = await findOwnColleague(db, user, c.req.valid("param").id);
        if (!found) {
          return c.json(colleagueNotFound, 404);
        }
        const { colleague } = found;
        return c.json(
          toColleague(colleague, !(await profileGranted(db, user.id, colleague.profileId))),
        );
      })
      .patch(
        "/:id",
        validate("param", idParamSchema),
        validate("json", colleagueUpdateSchema),
        async (c) => {
          const user = currentUser(c);
          const found = await findOwnColleague(db, user, c.req.valid("param").id);
          if (!found) {
            return c.json(colleagueNotFound, 404);
          }
          const { archived, ...input } = c.req.valid("json");
          const { colleague } = found;
          if (input.profileId && !(await profileGranted(db, user.id, input.profileId))) {
            return c.json(notGranted, 400);
          }
          if (
            input.name !== undefined &&
            (await colleagueNameTaken(db, colleague, input.name, colleague.id))
          ) {
            return c.json(nameTaken, 409);
          }
          const [row] = await db
            .update(colleagues)
            .set({
              ...input,
              ...(archived === undefined
                ? {}
                : { archivedAt: archived ? (colleague.archivedAt ?? new Date()) : null }),
              updatedAt: new Date(),
            })
            .where(eq(colleagues.id, colleague.id))
            .returning();
          if (!row) {
            return c.json(colleagueNotFound, 404);
          }
          if (input.profileId && input.profileId !== colleague.profileId) {
            waitingChanged(await cancelWaitingApprovals(db, [colleague.id], "profile_changed"));
          }
          return c.json(toColleague(row, !(await profileGranted(db, user.id, row.profileId))));
        },
      )
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const found = await findOwnColleague(db, currentUser(c), c.req.valid("param").id);
        if (!found) {
          return c.json(colleagueNotFound, 404);
        }
        await deleteColleague(db, found.colleague);
        return c.body(null, 204);
      })
  );
}
