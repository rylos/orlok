import type { OpsJob } from "@orlok/shared";
import {
  CheckCheck,
  ChevronRight,
  Loader2,
  Plug,
  Server,
  ShieldAlert,
  Square,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { isJobFinished, useStopJob } from "@/lib/ops-queries";
import { cn } from "@/lib/utils";
import { JobReason } from "./JobReason";

function statusVariant(job: OpsJob) {
  if (job.status === "done" && job.exitCode === 0) {
    return "success" as const;
  }
  return job.status === "pending_approval" || job.status === "running" ? "primary" : "neutral";
}

// A command of a virtual colleague: what, where and why, and its output (R-OPS). The card folds
// into one line as soon as the command ends, so what the colleague writes next is not pushed off
// the screen by a column of finished commands. What still needs reading stays open: a command
// still running, one waiting for approval, one that went wrong.
export function OpsJobCard({ job }: { job: OpsJob }) {
  const step = job.plan ? { step: job.plan.step, count: job.plan.stepCount } : null;
  const { t } = useTranslation();
  const stop = useStopJob(job.officeId);
  const [showOutput, setShowOutput] = useState(job.status === "failed");
  // null until the person opens or closes it by hand, and their choice then wins.
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null);
  const finished = isJobFinished(job);
  const wentWrong =
    job.error !== null ||
    job.status === "failed" ||
    job.status === "timeout" ||
    (job.status === "done" && (job.exitCode ?? 0) !== 0);
  const canFold = finished;
  const open = openedByHand ?? (!finished || wentWrong);
  const icon =
    job.target.kind === "runner" ? (
      <Terminal className="size-4 shrink-0 text-primary" aria-hidden />
    ) : job.target.kind === "mcp" ? (
      <Plug className="size-4 shrink-0 text-primary" aria-hidden />
    ) : (
      <Server className="size-4 shrink-0 text-primary" aria-hidden />
    );
  // While it runs, how many lines it has written so far: enough to see it is not stuck, without
  // a column of output growing in the conversation. The output itself shows once it ends.
  const linesSoFar =
    job.status === "running" && job.output ? job.output.replace(/\n$/, "").split("\n").length : 0;
  const badge = (
    <Badge variant={statusVariant(job)}>
      {!finished && job.status !== "pending_approval" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : null}
      {t(`chat.ops.statuses.${job.status}`)}
      {linesSoFar > 0 ? ` · ${t("chat.ops.linesSoFar", { count: linesSoFar })}` : ""}
      {job.exitCode !== null && job.status === "done" && job.exitCode !== 0
        ? ` · ${t("chat.ops.exitCode", { code: job.exitCode })}`
        : ""}
    </Badge>
  );
  // Ran without asking because the person always allows these command types: said quietly, so
  // they can tell why it did not ask, and take the approval back from their account if they wish.
  const alwaysAllowed =
    job.classification.decision === "allow" && !job.decidedBy
      ? job.classification.matchedRules
          .filter((rule) => rule.startsWith("type:"))
          .map((rule) => rule.slice("type:".length))
      : [];
  const alwaysAllowedText =
    alwaysAllowed.length > 0
      ? t("chat.ops.alwaysAllowed", { types: alwaysAllowed.join(", ") })
      : null;
  const target =
    job.target.kind === "runner"
      ? t("chat.ops.runner")
      : job.target.kind === "mcp"
        ? `${job.target.name} · ${job.target.tool}`
        : job.target.name;

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpenedByHand(true)}
        className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {icon}
        {step ? (
          <span className="shrink-0 text-xs text-muted-foreground">{`${step.step}/${step.count}`}</span>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">{target}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{job.command}</span>
        {alwaysAllowedText ? (
          <span title={alwaysAllowedText} className="shrink-0 text-muted-foreground">
            <CheckCheck className="size-3.5" aria-hidden />
            <span className="sr-only">{alwaysAllowedText}</span>
          </span>
        ) : null}
        {badge}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border bg-card p-3 text-sm",
        job.status === "pending_approval" && "border-primary/60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {canFold ? (
          <button
            type="button"
            aria-expanded={true}
            aria-label={t("chat.ops.fold")}
            onClick={() => setOpenedByHand(false)}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRight className="size-3.5 rotate-90 transition-transform" aria-hidden />
          </button>
        ) : null}
        {icon}
        {step ? (
          <span className="text-xs text-muted-foreground">{`${step.step}/${step.count}`}</span>
        ) : null}
        <span className="font-medium">{target}</span>
        {badge}
        {job.decidedBy ? (
          <span className="text-xs text-muted-foreground">
            {t("chat.ops.decidedBy", { name: job.decidedBy })}
          </span>
        ) : null}
        {alwaysAllowedText ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCheck className="size-3.5" aria-hidden />
            {alwaysAllowedText}
          </span>
        ) : null}
      </div>

      <pre className="overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
        {job.command}
      </pre>
      {job.reason ? <p className="text-muted-foreground">{job.reason}</p> : null}

      {job.status === "pending_approval" ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <JobReason frame="chat.ops.needsApproval" reason={job.classification.reason} />
        </p>
      ) : null}

      {job.status === "denied" && !job.decidedBy ? (
        <p className="text-xs text-destructive">
          <JobReason frame="chat.ops.refused" reason={job.classification.reason} />
        </p>
      ) : null}

      {!finished && job.status !== "pending_approval" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={stop.isPending}
          onClick={() => stop.mutate(job.id)}
        >
          <Square aria-hidden />
          {t("chat.ops.stop")}
        </Button>
      ) : null}

      {job.error ? (
        <p className="text-xs text-destructive">
          {t(`chat.ops.errors.${job.error}`, { defaultValue: job.error })}
        </p>
      ) : null}

      {finished && (job.output || job.truncated) ? (
        <div>
          <button
            type="button"
            aria-expanded={showOutput}
            onClick={() => setShowOutput((value) => !value)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", showOutput && "rotate-90")}
              aria-hidden
            />
            {t("chat.ops.output")}
          </button>
          {showOutput ? (
            <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
              {job.output}
              {job.truncated ? `\n${t("chat.ops.truncated")}` : ""}
            </pre>
          ) : null}
        </div>
      ) : null}

      {stop.isError ? <ErrorAlert>{translateError(t, stop.error)}</ErrorAlert> : null}
    </div>
  );
}
