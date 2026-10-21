import {
  approvalSchema,
  officeIdParamSchema,
  officeItemParamSchema,
  planDecisionSchema,
} from "@orlok/shared/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { currentUser, requireUser } from "../auth/middleware";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import { listAudit } from "../ops/audit";
import { decideJob, findJobRow, getJob, listJobs, stopJob } from "../ops/jobs";
import { decidePlan, getPlanRow, stopPlan } from "../ops/plans";
import { getWikiAccess } from "../services/wiki";
import { settlePromptsSoon } from "../telegram/prompts";
import type { AppEnv, Deps } from "../types";

const officeNotFound = errorBody("not_found", "Office not found");
const jobNotFound = errorBody("not_found", "Job not found");
const forbidden = errorBody("forbidden", "Only administrators and office managers can see this");
const notYours = errorBody("forbidden", "Only who asked for the intervention can decide");

const jobsQuerySchema = z.object({
  conversationId: z.uuid().optional(),
  ids: z.string().optional(),
});

// Colleague commands of an office: list, approval, stop and audit (R-OPS-4, R-OPS-5, R-SEC-1).
// Each person sees, decides and stops only the commands asked for them, administrators too:
// they were asked in a conversation nobody else can open. The audit log is for administrators and
// office managers.
export function opsRoutes(deps: Deps) {
  const { db, runner } = deps;
  return (
    new Hono<AppEnv>()
      .use(requireUser)
      .get(
        "/:officeId/ops/jobs",
        validate("param", officeIdParamSchema),
        validate("query", jobsQuerySchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          if (!(await getWikiAccess(db, currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          const { conversationId, ids } = c.req.valid("query");
          return c.json(
            await listJobs(db, officeId, {
              requestedForUserId: currentUser(c).id,
              ...(conversationId ? { conversationId } : {}),
              ...(ids ? { ids: ids.split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id)) } : {}),
            }),
          );
        },
      )
      .get("/:officeId/ops/jobs/:id", validate("param", officeItemParamSchema), async (c) => {
        const { officeId, id } = c.req.valid("param");
        if (!(await getWikiAccess(db, currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        const job = await getJob(db, officeId, id, currentUser(c).id);
        return job ? c.json(job) : c.json(jobNotFound, 404);
      })
      .post(
        "/:officeId/ops/jobs/:id/decision",
        validate("param", officeItemParamSchema),
        validate("json", approvalSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          if (!(await getWikiAccess(db, user, officeId))) {
            return c.json(officeNotFound, 404);
          }
          const row = await findJobRow(db, id);
          if (!row || row.officeId !== officeId) {
            return c.json(jobNotFound, 404);
          }
          if (row.requestedForUserId !== user.id) {
            return c.json(notYours, 403);
          }
          const decided = await decideJob(db, officeId, id, c.req.valid("json").choice, user.id);
          if (!decided) {
            return c.json(errorBody("conflict", "The job is not waiting for approval"), 409);
          }
          // The same request on Telegram shows the outcome and loses its buttons (R-CHAT-12).
          settlePromptsSoon(deps);
          return c.json(await getJob(db, officeId, id, user.id));
        },
      )
      .post("/:officeId/ops/jobs/:id/stop", validate("param", officeItemParamSchema), async (c) => {
        const user = currentUser(c);
        const { officeId, id } = c.req.valid("param");
        const access = await getWikiAccess(db, user, officeId);
        if (!access) {
          return c.json(officeNotFound, 404);
        }
        const job = await findJobRow(db, id);
        if (!job || job.officeId !== officeId) {
          return c.json(jobNotFound, 404);
        }
        if (job.requestedForUserId !== user.id) {
          return c.json(notYours, 403);
        }
        await stopJob({ db, runner }, job, user.id);
        return c.json(await getJob(db, officeId, id, user.id));
      })
      // Plans (R-OPS-6): approve or deny the whole plan, or stop what is left of it.
      .post(
        "/:officeId/ops/plans/:id/decision",
        validate("param", officeItemParamSchema),
        validate("json", planDecisionSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          if (!(await getWikiAccess(db, user, officeId))) {
            return c.json(officeNotFound, 404);
          }
          const row = await getPlanRow(db, id);
          if (!row || row.officeId !== officeId) {
            return c.json(errorBody("not_found", "Plan not found"), 404);
          }
          if (row.requestedForUserId !== user.id) {
            return c.json(notYours, 403);
          }
          const plan = await decidePlan(db, officeId, id, c.req.valid("json").choice, user.id);
          if (!plan) {
            return c.json(errorBody("conflict", "The plan has already ended"), 409);
          }
          settlePromptsSoon(deps);
          return c.json({ id: plan.id, status: plan.status });
        },
      )
      .post(
        "/:officeId/ops/plans/:id/stop",
        validate("param", officeItemParamSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          const access = await getWikiAccess(db, user, officeId);
          if (!access) {
            return c.json(officeNotFound, 404);
          }
          const plan = await getPlanRow(db, id);
          if (!plan || plan.officeId !== officeId) {
            return c.json(errorBody("not_found", "Plan not found"), 404);
          }
          if (plan.requestedForUserId !== user.id) {
            return c.json(notYours, 403);
          }
          const stopped = await stopPlan({ db, runner }, plan, user.id);
          return c.json({ id: plan.id, status: stopped?.status ?? plan.status });
        },
      )
      .get("/:officeId/ops/audit", validate("param", officeIdParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        const access = await getWikiAccess(db, currentUser(c), officeId);
        if (!access) {
          return c.json(officeNotFound, 404);
        }
        if (!access.canEdit) {
          return c.json(forbidden, 403);
        }
        return c.json(await listAudit(db, officeId));
      })
  );
}
