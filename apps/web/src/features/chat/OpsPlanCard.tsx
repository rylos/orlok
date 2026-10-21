import type { OpsJob } from "@orlok/shared";
import { Ban, Check, CheckCheck, ListChecks, Loader2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useDecideJob, useStopPlan } from "@/lib/ops-queries";
import { cn } from "@/lib/utils";
import { OpsJobCard } from "./OpsJobCard";

// A step whose command types can be remembered: not an MCP tool, readable to the end.
function canAlways(job: OpsJob) {
  return (
    job.target.kind !== "mcp" &&
    job.classification.onceOnly !== true &&
    (job.classification.types ?? []).length > 0
  );
}

// A plan of a virtual colleague: its steps in order, approved as a whole or one by one (R-OPS-6).
export function OpsPlanCard({ officeId, jobs }: { officeId: string; jobs: OpsJob[] }) {
  const { t } = useTranslation();
  const stop = useStopPlan(officeId);
  const decide = useDecideJob(officeId);
  const steps = [...jobs].sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0));
  const plan = steps.find((job) => job.plan)?.plan;
  if (!plan) {
    return null;
  }
  const waiting = steps.some((job) => job.status === "pending_approval");
  const open = plan.status === "pending_approval" || plan.status === "running";
  const error = stop.error ?? decide.error;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border bg-card/50 p-3 text-sm",
        waiting && "border-primary/60",
      )}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <ListChecks className="size-4 text-primary" aria-hidden />
          <span className="text-xs text-muted-foreground">{t("chat.ops.plan.label")}</span>
          <span className="font-medium">{plan.title}</span>
          <Badge variant={plan.status === "done" ? "success" : open ? "primary" : "neutral"}>
            {plan.status === "running" ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
            {t(`chat.ops.plan.statuses.${plan.status}`)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("chat.ops.plan.steps", { count: plan.stepCount })}
          </span>
        </div>
        {plan.summary ? (
          <p className="whitespace-pre-wrap text-muted-foreground">{plan.summary}</p>
        ) : null}
      </div>

      {plan.status === "running" && !waiting ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={stop.isPending}
          onClick={() => stop.mutate(plan.id)}
        >
          <Square aria-hidden />
          {t("chat.ops.plan.stop")}
        </Button>
      ) : null}
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}

      <ol className="space-y-2">
        {steps.map((job) => (
          <li key={job.id} className="space-y-1.5">
            <OpsJobCard job={job} />
            {/* One step at a time, instead of the whole plan from the strip (R-OPS-6). */}
            {job.status === "pending_approval" ? (
              <div className="flex flex-wrap gap-2 pl-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: job.id, choice: "once" })}
                >
                  <Check aria-hidden />
                  {t("chat.ops.plan.approveStep")}
                </Button>
                {/* As for one command: the step's types, for this person only (R-OPS-4). */}
                {canAlways(job) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: job.id, choice: "always" })}
                  >
                    <CheckCheck aria-hidden />
                    {t("chat.ops.allowAlways")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: job.id, choice: "deny" })}
                >
                  <Ban aria-hidden />
                  {t("chat.ops.plan.denyStep")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
