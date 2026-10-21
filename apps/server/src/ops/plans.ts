import type { PlanDecision } from "@orlok/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { type OpsJobRow, type OpsPlanRow, opsJobs, opsPlans } from "../db/schema";
import type { Deps } from "../types";
import { approveTypes } from "./approved-types";
import { audit } from "./audit";
import type { WorkingPolicy } from "./hosts";
import {
  advancePlan,
  classifyForColleague,
  FINISHED_STATUSES,
  formatJobResult,
  type JobTarget,
  PLAN_FINISHED_STATUSES,
  requestJob,
  stopJob,
  waitingChanged,
} from "./jobs";

// Plans proposed by colleagues (R-OPS-6): ordered steps, approved as a whole or one by one.

const POLL_MS = 1_000;

export type PlanStepInput = {
  target: JobTarget;
  command: string;
  reason: string;
  timeoutSeconds: number;
};

export async function requestPlan(
  db: Db,
  input: {
    officeId: string;
    colleagueId: string;
    conversationId: string | null;
    userId: string | null;
    title: string;
    summary: string | null;
    steps: PlanStepInput[];
    policy: WorkingPolicy;
  },
) {
  // Classified before anything is stored: a refused step refuses the whole plan, and no step
  // of it can start meanwhile.
  const refusedIndex = input.steps.findIndex(
    (step) => classifyForColleague(step.target, step.command, input.policy).decision === "deny",
  );
  const [plan] = await db
    .insert(opsPlans)
    .values({
      officeId: input.officeId,
      colleagueId: input.colleagueId,
      conversationId: input.conversationId,
      requestedForUserId: input.userId,
      title: input.title,
      summary: input.summary,
      status: refusedIndex >= 0 ? "denied" : "pending_approval",
      ...(refusedIndex >= 0 ? { finishedAt: new Date() } : {}),
    })
    .returning();
  if (!plan) {
    throw new Error("Plan insert returned no row");
  }
  const jobs: OpsJobRow[] = [];
  for (const [index, step] of input.steps.entries()) {
    jobs.push(
      await requestJob(db, {
        officeId: input.officeId,
        colleagueId: input.colleagueId,
        conversationId: input.conversationId,
        userId: input.userId,
        target: step.target,
        command: step.command,
        reason: step.reason,
        timeoutSeconds: step.timeoutSeconds,
        policy: input.policy,
        plan: { id: plan.id, step: index + 1 },
      }),
    );
  }
  await audit(db, {
    officeId: input.officeId,
    actor: { colleagueId: input.colleagueId },
    action: "plan.request",
    target: input.title,
    detail: {
      plan: plan.id,
      steps: jobs.map((job) => ({ job: job.id, decision: job.classification.decision })),
    },
  });

  if (refusedIndex >= 0) {
    await db
      .update(opsJobs)
      .set({ status: "stopped", error: "plan_refused", finishedAt: new Date(), reported: true })
      .where(
        and(eq(opsJobs.planId, plan.id), inArray(opsJobs.status, ["pending_approval", "queued"])),
      );
    return { plan, jobs: await planSteps(db, plan.id), refused: jobs[refusedIndex] ?? null };
  }
  const updated = await advancePlan(db, plan.id);
  return { plan: updated ?? plan, jobs: await planSteps(db, plan.id), refused: null };
}

export async function planSteps(db: Db, planId: string) {
  return db.select().from(opsJobs).where(eq(opsJobs.planId, planId)).orderBy(asc(opsJobs.planStep));
}

export async function getPlanRow(db: Db, id: string) {
  const [row] = await db.select().from(opsPlans).where(eq(opsPlans.id, id)).limit(1);
  return row ?? null;
}

// A person approves every step still waiting, or denies the steps that did not run yet. With
// "approve_always" the types of the steps that can be read to the end are remembered for that
// person, as "always" does for one command (R-OPS-4); the others run this time only.
export async function decidePlan(
  db: Db,
  officeId: string,
  planId: string,
  choice: PlanDecision,
  userId: string,
) {
  const [plan] = await db
    .select()
    .from(opsPlans)
    .where(and(eq(opsPlans.id, planId), eq(opsPlans.officeId, officeId)))
    .limit(1);
  if (!plan || PLAN_FINISHED_STATUSES.includes(plan.status)) {
    return null;
  }
  const types: string[] = [];
  if (choice === "approve_always") {
    const waiting = await db
      .select()
      .from(opsJobs)
      .where(and(eq(opsJobs.planId, planId), eq(opsJobs.status, "pending_approval")));
    for (const step of waiting) {
      const { types: missing, onceOnly } = step.classification;
      if (step.targetKind === "mcp" || !step.requestedForUserId || onceOnly || !missing?.length) {
        continue;
      }
      const approved = await approveTypes(db, {
        userId: step.requestedForUserId,
        shell: step.shell,
        types: missing,
      });
      for (const type of approved) if (!types.includes(type)) types.push(type);
    }
  }
  if (choice !== "deny") {
    await db
      .update(opsJobs)
      .set({ status: "queued", decidedByUserId: userId })
      .where(and(eq(opsJobs.planId, planId), eq(opsJobs.status, "pending_approval")));
  } else {
    await db
      .update(opsJobs)
      .set({ status: "denied", decidedByUserId: userId, finishedAt: new Date() })
      .where(
        and(eq(opsJobs.planId, planId), inArray(opsJobs.status, ["pending_approval", "queued"])),
      );
  }
  await db.update(opsPlans).set({ decidedByUserId: userId }).where(eq(opsPlans.id, planId));
  await audit(db, {
    officeId,
    actor: { userId },
    action: choice === "deny" ? "plan.deny" : "plan.approve",
    target: plan.title,
    detail: { plan: plan.id, choice, ...(types.length > 0 ? { types } : {}) },
  });
  const updated = await advancePlan(db, planId);
  waitingChanged([plan]);
  return updated;
}

export async function stopPlan(
  deps: Pick<Deps, "db" | "runner">,
  plan: OpsPlanRow,
  userId: string,
) {
  for (const step of await planSteps(deps.db, plan.id)) {
    if (!FINISHED_STATUSES.includes(step.status)) {
      await stopJob(deps, step, userId);
    }
  }
  return advancePlan(deps.db, plan.id);
}

export async function waitForPlan(
  db: Db,
  id: string,
  done: (plan: OpsPlanRow) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getPlanRow(db, id);
    if (!row || done(row) || Date.now() >= deadline || signal?.aborted) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Marks the plan and its steps as given back to the colleague; false when already done.
export async function markPlanReported(db: Db, id: string) {
  const [row] = await db
    .update(opsPlans)
    .set({ reported: true })
    .where(and(eq(opsPlans.id, id), eq(opsPlans.reported, false)))
    .returning({ id: opsPlans.id });
  await db.update(opsJobs).set({ reported: true }).where(eq(opsJobs.planId, id));
  return Boolean(row);
}

export function formatPlanResult(plan: OpsPlanRow, steps: OpsJobRow[]) {
  return [
    `Plan ${plan.id} "${plan.title}": ${plan.status}.`,
    ...steps.map((step) =>
      FINISHED_STATUSES.includes(step.status) &&
      step.status !== "stopped" &&
      step.status !== "denied"
        ? `Step ${step.planStep}: ${formatJobResult(step)}`
        : `Step ${step.planStep} on ${step.targetName}: ${step.status}${step.error ? ` (${step.error})` : ""} — ${step.command}`,
    ),
  ].join("\n\n");
}
