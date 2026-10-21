import {
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  officeIdParamSchema,
  officeItemParamSchema,
} from "@orlok/shared/schemas";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import { errorBody, uniqueViolation } from "../../lib/errors";
import { validate } from "../../lib/validation";
import {
  createMcpServer,
  deleteMcpServer,
  findMcpServer,
  listMcpServers,
  refreshMcpTools,
  toMcpServer,
  updateMcpServer,
} from "../../mcp/servers";
import { findOffice } from "../../services/offices";
import type { AppEnv, Deps } from "../../types";

const officeNotFound = errorBody("not_found", "Office not found");
const serverNotFound = errorBody("not_found", "MCP server not found");
const nameTaken = errorBody(
  "conflict",
  "An MCP server with this name already exists in the office",
);

// MCP servers of an office (R-OPS-10), administrators only.
export function mcpAdminRoutes({ db, config, runner }: Deps) {
  const mcpDeps = { runner, secretKey: config.secretKey };
  return new Hono<AppEnv>()
    .get("/offices/:officeId/mcp-servers", validate("param", officeIdParamSchema), async (c) => {
      const { officeId } = c.req.valid("param");
      if (!(await findOffice(db, officeId))) {
        return c.json(officeNotFound, 404);
      }
      return c.json((await listMcpServers(db, officeId)).map(toMcpServer));
    })
    .post(
      "/offices/:officeId/mcp-servers",
      validate("param", officeIdParamSchema),
      validate("json", mcpServerCreateSchema),
      async (c) => {
        const { officeId } = c.req.valid("param");
        if (!(await findOffice(db, officeId))) {
          return c.json(officeNotFound, 404);
        }
        try {
          const created = await createMcpServer(
            db,
            officeId,
            c.req.valid("json"),
            config.secretKey,
            currentUser(c).id,
          );
          return c.json(toMcpServer(await refreshMcpTools(db, created, mcpDeps)), 201);
        } catch (error) {
          if (uniqueViolation(error) !== null) {
            return c.json(nameTaken, 409);
          }
          throw error;
        }
      },
    )
    .patch(
      "/offices/:officeId/mcp-servers/:id",
      validate("param", officeItemParamSchema),
      validate("json", mcpServerUpdateSchema),
      async (c) => {
        const { officeId, id } = c.req.valid("param");
        const current = await findMcpServer(db, officeId, id);
        if (!current) {
          return c.json(serverNotFound, 404);
        }
        const updated = await updateMcpServer(
          db,
          current,
          c.req.valid("json"),
          config.secretKey,
          currentUser(c).id,
        );
        return updated
          ? c.json(toMcpServer(await refreshMcpTools(db, updated, mcpDeps)))
          : c.json(serverNotFound, 404);
      },
    )
    .delete(
      "/offices/:officeId/mcp-servers/:id",
      validate("param", officeItemParamSchema),
      async (c) => {
        const { officeId, id } = c.req.valid("param");
        const current = await findMcpServer(db, officeId, id);
        if (!current) {
          return c.json(serverNotFound, 404);
        }
        await deleteMcpServer(db, current, currentUser(c).id);
        return c.body(null, 204);
      },
    )
    .post(
      "/offices/:officeId/mcp-servers/:id/refresh",
      validate("param", officeItemParamSchema),
      async (c) => {
        const { officeId, id } = c.req.valid("param");
        const current = await findMcpServer(db, officeId, id);
        if (!current) {
          return c.json(serverNotFound, 404);
        }
        return c.json(toMcpServer(await refreshMcpTools(db, current, mcpDeps)));
      },
    );
}
