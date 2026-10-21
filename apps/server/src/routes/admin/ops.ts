import type { RunnerHealth } from "@orlok/shared";
import { auditExportSchema, hostCreateSchema, hostUpdateSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import { errorBody, uniqueViolation } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { audit, auditCsv, exportAudit, listAudit } from "../../ops/audit";
import { createHost, deleteHost, findHost, listHosts, toHost, updateHost } from "../../ops/hosts";
import type { AppEnv, Deps } from "../../types";

const hostNotFound = errorBody("not_found", "Host not found");
const nameTaken = errorBody("conflict", "A host with this name already exists", [
  { path: "name", code: "name_taken" },
]);

// Host registry and installation log (R-OPS-1, R-SEC-1), administrators only. Credentials are
// personal: see routes/credentials.ts.
export function opsAdminRoutes({ db, runner }: Deps) {
  return (
    new Hono<AppEnv>()
      .get("/runner", async (c) => {
        if (!runner) {
          return c.json({ configured: false, health: null });
        }
        try {
          return c.json({ configured: true, health: await runner.health() });
        } catch (error) {
          return c.json({
            configured: true,
            health: null,
            error: error instanceof Error ? error.message : "Runner unreachable",
          });
        }
      })
      // --- Hosts ---
      .get("/hosts", async (c) => c.json((await listHosts(db)).map(toHost)))
      .post("/hosts", validate("json", hostCreateSchema), async (c) => {
        try {
          return c.json(await createHost(db, c.req.valid("json"), currentUser(c).id), 201);
        } catch (error) {
          if (uniqueViolation(error) !== null) {
            return c.json(nameTaken, 409);
          }
          throw error;
        }
      })
      .patch(
        "/hosts/:id",
        validate("param", idParamSchema),
        validate("json", hostUpdateSchema),
        async (c) => {
          const current = await findHost(db, c.req.valid("param").id);
          if (!current) {
            return c.json(hostNotFound, 404);
          }
          const input = c.req.valid("json");
          // WinRM reaches Windows only, whichever of the two changes.
          if (
            (input.connection ?? current.connection) !== "ssh" &&
            (input.kind ?? current.kind) !== "windows"
          ) {
            return c.json(
              errorBody("validation_failed", "WinRM reaches Windows hosts only", [
                { path: "connection", code: "invalid_value" },
              ]),
              400,
            );
          }
          try {
            const updated = await updateHost(db, current, input, currentUser(c).id);
            return updated ? c.json(updated) : c.json(hostNotFound, 404);
          } catch (error) {
            if (uniqueViolation(error) !== null) {
              return c.json(nameTaken, 409);
            }
            throw error;
          }
        },
      )
      .delete("/hosts/:id", validate("param", idParamSchema), async (c) => {
        const current = await findHost(db, c.req.valid("param").id);
        if (!current) {
          return c.json(hostNotFound, 404);
        }
        await deleteHost(db, current, currentUser(c).id);
        return c.body(null, 204);
      })
      // Events that belong to no office: hosts and people's credentials (R-SEC-1).
      .get("/audit", async (c) => c.json(await listAudit(db, null)))
      // The whole audit log, installation and offices, for an auditor or a spreadsheet (R-SEC-5).
      // The export is itself an event of the installation log.
      .get("/audit/export", validate("query", auditExportSchema), async (c) => {
        const { format, from, to } = c.req.valid("query");
        const rows = await exportAudit(db, {
          ...(from ? { from: new Date(`${from}T00:00:00Z`) } : {}),
          ...(to ? { to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000) } : {}),
        });
        await audit(db, {
          officeId: null,
          actor: { userId: currentUser(c).id },
          action: "audit.exported",
          target: format,
          detail: { from: from ?? null, to: to ?? null, rows: rows.length },
        });
        const stamp = new Date().toISOString().slice(0, 10);
        const body =
          format === "csv"
            ? `\uFEFF${auditCsv(rows)}`
            : rows.map((row) => JSON.stringify(row)).join("\n");
        return c.body(body, 200, {
          "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
          "Content-Disposition": `attachment; filename="orlok-audit-${stamp}.${format === "csv" ? "csv" : "jsonl"}"`,
        });
      })
  );
}

export type RunnerStatus = {
  configured: boolean;
  health: RunnerHealth | null;
  error?: string;
};
