import type { OpsJob } from "@orlok/shared";
import { Ban, Check, CheckCheck, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useDecideJob, useDecidePlan } from "@/lib/ops-queries";
import { cn } from "@/lib/utils";
import { JobReason } from "./JobReason";

// What waits for the person right now, kept between the conversation and the message box: an
// approval that arrived while they were reading further up would otherwise sit below the fold
// (R-OPS-4). One at a time, the oldest first, so a colleague running several commands does not
// turn the chat into a wall of questions.
export function ApprovalDock({
  officeId,
  jobs,
  layoutClass,
}: {
  officeId: string;
  jobs: OpsJob[];
  layoutClass: string;
}) {
  const { t } = useTranslation();
  const decideJob = useDecideJob(officeId);
  const decidePlan = useDecidePlan(officeId);
  const waiting = jobs
    .filter((job) => job.status === "pending_approval")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const job = waiting[0];
  if (!job) {
    return null;
  }
  // A step of a plan not yet approved is decided here as a whole plan; the steps can also be
  // approved one by one from the plan's card in the conversation.
  const plan = job.plan?.status === "pending_approval" ? job.plan : null;
  const steps = plan
    ? jobs
        .filter((item) => item.plan?.id === plan.id)
        .sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0))
    : [];
  const pending = decideJob.isPending || decidePlan.isPending;
  // "Always" remembers the command types still missing, for this person with every colleague, on
  // every host and on the runner. A tool of an MCP server, or a command that cannot be read to the
  // end, is allowed once only.
  const types = job.classification.types ?? [];
  const onceOnly = job.target.kind !== "mcp" && job.classification.onceOnly === true;
  const canAlways = job.target.kind !== "mcp" && !onceOnly && types.length > 0;
  // For a plan: the types of its waiting steps that can be remembered, and how many steps can
  // be allowed this time only.
  const planSteps = plan ? waiting.filter((step) => step.plan?.id === plan.id) : [];
  const rememberable = planSteps.filter(
    (step) =>
      step.target.kind !== "mcp" &&
      step.classification.onceOnly !== true &&
      (step.classification.types ?? []).length > 0,
  );
  const planTypes = [...new Set(rememberable.flatMap((step) => step.classification.types ?? []))];
  const planOnce = planSteps.filter(
    (step) => step.target.kind === "mcp" || step.classification.onceOnly === true,
  ).length;
  const error = decideJob.error ?? decidePlan.error;
  const target =
    job.target.kind === "runner"
      ? t("chat.ops.runner")
      : job.target.kind === "mcp"
        ? `${job.target.name} · ${job.target.tool}`
        : job.target.name;

  return (
    <div className="border-t border-primary/40 bg-primary/5 px-4 py-3">
      <div className={cn("space-y-2", layoutClass)}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <span className="font-medium">
            {plan ? t("chat.ops.dock.planTitle", { title: plan.title }) : t("chat.ops.dock.title")}
          </span>
          <span className="text-xs text-muted-foreground">{target}</span>
          {waiting.length > 1 ? (
            <span className="text-xs text-muted-foreground">
              {t("chat.ops.dock.more", { count: waiting.length - 1 })}
            </span>
          ) : null}
        </div>

        {plan ? (
          <>
            {plan.summary ? <p className="text-sm">{plan.summary}</p> : null}
            {/* What will run, not only what the colleague says it does. */}
            <ol className="space-y-1">
              {steps.map((step) => (
                <li key={step.id} className="flex gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {step.plan?.step}.
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-muted-foreground">
                      {step.target.kind === "runner"
                        ? t("chat.ops.runner")
                        : step.target.kind === "host"
                          ? step.target.name
                          : `${step.target.name} · ${step.target.tool}`}
                    </span>
                    <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-2 py-1 font-mono whitespace-pre-wrap">
                      {step.command}
                    </pre>
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <pre className="max-h-64 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
            {job.toolInput ?? job.command}
          </pre>
        )}
        {job.reason ? <p className="text-xs text-muted-foreground">{job.reason}</p> : null}
        {(plan ? planTypes.length > 0 : canAlways) ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{t("chat.ops.toApprove")}</span>
            {(plan ? planTypes : types).map((type) => (
              <code
                key={type}
                className="rounded border border-warning/60 bg-warning/15 px-1.5 py-0.5 font-mono"
              >
                {type}
              </code>
            ))}
          </p>
        ) : null}
        {!plan && onceOnly ? (
          <p className="text-xs text-muted-foreground">
            <JobReason frame="chat.ops.onceOnly" reason={job.classification.reason} />
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {plan ? (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => decidePlan.mutate({ id: plan.id, choice: "approve" })}
              >
                <CheckCheck aria-hidden />
                {t("chat.ops.plan.approve")}
              </Button>
              {planTypes.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => decidePlan.mutate({ id: plan.id, choice: "approve_always" })}
                >
                  <CheckCheck aria-hidden />
                  {t("chat.ops.plan.approveAlways")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => decidePlan.mutate({ id: plan.id, choice: "deny" })}
              >
                <Ban aria-hidden />
                {t("chat.ops.plan.deny")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => decideJob.mutate({ id: job.id, choice: "once" })}
              >
                <Check aria-hidden />
                {t("chat.ops.allowOnce")}
              </Button>
              {canAlways ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => decideJob.mutate({ id: job.id, choice: "always" })}
                >
                  <CheckCheck aria-hidden />
                  {t("chat.ops.allowAlways")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => decideJob.mutate({ id: job.id, choice: "deny" })}
              >
                <Ban aria-hidden />
                {t("chat.ops.deny")}
              </Button>
            </>
          )}
        </div>
        {!plan && canAlways ? (
          <p className="text-xs text-muted-foreground">
            {t("chat.ops.allowAlwaysScope", { count: types.length })}
          </p>
        ) : null}
        {plan && planTypes.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("chat.ops.allowAlwaysScope", { count: planTypes.length })}
            {planOnce > 0 ? ` ${t("chat.ops.plan.onceSteps", { count: planOnce })}` : ""}
          </p>
        ) : null}
        {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
      </div>
    </div>
  );
}
