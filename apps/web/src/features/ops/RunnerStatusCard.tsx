import { CheckCircle2, CircleAlert, Container, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { translateError } from "@/i18n/errors";
import { useRunnerStatus } from "@/lib/ops-admin-queries";

// Orlok runner: isolated container that runs the commands (R-OPS-2).
export function RunnerStatusCard() {
  const { t } = useTranslation();
  const runner = useRunnerStatus();

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Container className="size-4 text-primary" aria-hidden />
          <h2 className="font-semibold">{t("ops.runner.title")}</h2>
          {runner.data ? (
            runner.data.health ? (
              <Badge variant="success">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {t("ops.runner.reachable")}
              </Badge>
            ) : runner.data.configured ? (
              <Badge className="border-destructive/40 bg-destructive/10 text-foreground">
                <CircleAlert className="size-3.5 text-destructive" aria-hidden />
                {t("ops.runner.unreachable")}
              </Badge>
            ) : (
              <Badge>{t("ops.runner.notConfigured")}</Badge>
            )
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={runner.isFetching}
          onClick={() => void runner.refetch()}
        >
          {runner.isFetching ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <RefreshCw aria-hidden />
          )}
          {t("ops.refresh")}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">{t("ops.runner.description")}</p>

      {runner.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : runner.isError ? (
        <ErrorAlert>{translateError(t, runner.error)}</ErrorAlert>
      ) : !runner.data.configured ? (
        <p className="text-sm text-muted-foreground">
          {t("ops.runner.howToConfigure")}{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">ORLOK_RUNNER_URL</code>
          {", "}
          <code className="rounded bg-muted px-1 font-mono text-xs">ORLOK_RUNNER_TOKEN</code>
        </p>
      ) : runner.data.health ? (
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">{t("ops.runner.version")}</span>{" "}
            <span className="font-mono">{runner.data.health.version}</span>
          </p>
          <div className="space-y-1">
            <p className="text-muted-foreground">{t("ops.runner.tools")}</p>
            {runner.data.health.tools.length === 0 ? (
              <p className="text-muted-foreground">{t("ops.runner.noTools")}</p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {runner.data.health.tools.map((tool) => (
                  <li key={tool}>
                    <Badge className="font-mono">{tool}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <ErrorAlert>
          {t("ops.runner.unreachableDetail", { message: runner.data.error ?? "" })}
        </ErrorAlert>
      )}
    </Card>
  );
}
