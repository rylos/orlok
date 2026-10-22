import {
  officeColleagueCreateSchema,
  officeColleagueUpdateSchema,
  officeCreateSchema,
  officeUpdateSchema,
} from "@orlok/shared/schemas";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import type { Db } from "../../db/client";
import { colleagues, offices } from "../../db/schema";
import { errorBody, uniqueViolation } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { deleteColleague, findOfficeColleague, toColleague } from "../../services/colleagues";
import { findProfile } from "../../services/models";
import { findOffice, listAdminOffices, toOffice } from "../../services/offices";
import { clearWiki } from "../../services/wiki";
import { isCheckRunning } from "../../services/wiki-check";
import type { AppEnv, Deps } from "../../types";

async function officeNameTaken(db: Db, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: offices.id })
    .from(offices)
    .where(
      exceptId ? and(eq(offices.name, name), ne(offices.id, exceptId)) : eq(offices.name, name),
    )
    .limit(1);
  return row !== undefined;
}

const officeNotFound = errorBody("not_found", "Office not found");
const officeConflict = errorBody("conflict", "An office with this name already exists");
const colleagueNotFound = errorBody("not_found", "This office has no colleague");
const colleagueExists = errorBody("conflict", "This office already has its colleague");
const unknownProfile = errorBody("validation_failed", "Unknown model profile", [
  { path: "profileId", code: "invalid_value" },
]);
const wikiBusy = errorBody(
  "wiki_busy",
  "A document is being read into the wiki: wait for it to finish, then try again",
);

// Offices (R-ADM-2), administrators only, with the colleague of each office (R-ADM-8). Personal
// colleagues belong to each person: see routes/colleagues.ts.
export function officeRoutes({ db }: Deps) {
  return (
    new Hono<AppEnv>()
      .get("/", async (c) => c.json(await listAdminOffices(db)))
      .post("/", validate("json", officeCreateSchema), async (c) => {
        const input = c.req.valid("json");
        if (await officeNameTaken(db, input.name)) {
          return c.json(officeConflict, 409);
        }
        const [row] = await db
          .insert(offices)
          .values({ name: input.name, description: input.description || null })
          .returning();
        if (!row) {
          throw new Error("Office insert returned no row");
        }
        return c.json(toOffice(row), 201);
      })
      .patch(
        "/:id",
        validate("param", idParamSchema),
        validate("json", officeUpdateSchema),
        async (c) => {
          const { id } = c.req.valid("param");
          const input = c.req.valid("json");
          if (input.name !== undefined && (await officeNameTaken(db, input.name, id))) {
            return c.json(officeConflict, 409);
          }
          const [row] = await db
            .update(offices)
            .set({
              name: input.name,
              ...(input.description === undefined
                ? {}
                : { description: input.description || null }),
            })
            .where(eq(offices.id, id))
            .returning();
          return row ? c.json(toOffice(row)) : c.json(officeNotFound, 404);
        },
      )
      // Deleting an office also deletes everyone's colleagues there and their conversations.
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        const deleted = await db
          .delete(offices)
          .where(eq(offices.id, id))
          .returning({ id: offices.id });
        return deleted.length > 0 ? c.body(null, 204) : c.json(officeNotFound, 404);
      })
      // The office colleague: any profile, whoever holds it, since it only reads the wiki. Its
      // owner is only who created it.
      .post(
        "/:id/colleague",
        validate("param", idParamSchema),
        validate("json", officeColleagueCreateSchema),
        async (c) => {
          const { id } = c.req.valid("param");
          const input = c.req.valid("json");
          if (!(await findOffice(db, id))) {
            return c.json(officeNotFound, 404);
          }
          if (!(await findProfile(db, input.profileId))) {
            return c.json(unknownProfile, 400);
          }
          if (await findOfficeColleague(db, id)) {
            return c.json(colleagueExists, 409);
          }
          try {
            const [row] = await db
              .insert(colleagues)
              .values({ ...input, officeId: id, userId: currentUser(c).id, officeWide: true })
              .returning();
            if (!row) {
              throw new Error("Colleague insert returned no row");
            }
            return c.json(toColleague(row, false), 201);
          } catch (error) {
            // Two administrators creating it at the same moment.
            if (uniqueViolation(error) === "colleagues_office_wide_idx") {
              return c.json(colleagueExists, 409);
            }
            throw error;
          }
        },
      )
      .patch(
        "/:id/colleague",
        validate("param", idParamSchema),
        validate("json", officeColleagueUpdateSchema),
        async (c) => {
          const found = await findOfficeColleague(db, c.req.valid("param").id);
          if (!found) {
            return c.json(colleagueNotFound, 404);
          }
          const { archived, ...input } = c.req.valid("json");
          if (input.profileId && !(await findProfile(db, input.profileId))) {
            return c.json(unknownProfile, 400);
          }
          const [row] = await db
            .update(colleagues)
            .set({
              ...input,
              ...(archived === undefined
                ? {}
                : { archivedAt: archived ? (found.archivedAt ?? new Date()) : null }),
              updatedAt: new Date(),
            })
            .where(eq(colleagues.id, found.id))
            .returning();
          return row
            ? c.json(toColleague(row, row.profileId === null))
            : c.json(colleagueNotFound, 404);
        },
      )
      // Deleting it deletes everyone's conversations with it.
      .delete("/:id/colleague", validate("param", idParamSchema), async (c) => {
        const found = await findOfficeColleague(db, c.req.valid("param").id);
        if (!found) {
          return c.json(colleagueNotFound, 404);
        }
        await deleteColleague(db, found);
        return c.body(null, 204);
      })
      // Empties the office wiki so it can be imported again from scratch.
      .delete("/:id/wiki", validate("param", idParamSchema), async (c) => {
        const { id } = c.req.valid("param");
        if (!(await findOffice(db, id))) {
          return c.json(officeNotFound, 404);
        }
        if (isCheckRunning(id)) {
          return c.json(wikiBusy, 409);
        }
        const cleared = await clearWiki(db, id);
        return cleared ? c.json(cleared) : c.json(wikiBusy, 409);
      })
  );
}
