import { officeCreateSchema, officeUpdateSchema } from "@orlok/shared/schemas";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { offices } from "../../db/schema";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
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
const wikiBusy = errorBody(
  "wiki_busy",
  "A document is being read into the wiki: wait for it to finish, then try again",
);

// Offices (R-ADM-2), administrators only. Colleagues belong to each person: see
// routes/colleagues.ts.
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
