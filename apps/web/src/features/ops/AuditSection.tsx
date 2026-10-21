import { Bot, Download, Loader2, RefreshCw, User } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError } from "@/i18n/errors";
import { useColleagueRefName } from "@/lib/colleague-queries";
import { useInstallationAudit, useOpsAudit } from "@/lib/ops-admin-queries";
import { formatDateTime } from "./format";

// Latest operations events of the office (R-SEC-1).
export function AuditSection({ officeId }: { officeId: string }) {
  const { t } = useTranslation();
  return (
    <AuditLog
      id="ops-audit-title"
      title={t("ops.audit.title")}
      description={t("ops.audit.description")}
      audit={useOpsAudit(officeId)}
    />
  );
}

// Events that belong to no office: hosts and people's credentials (R-SEC-1).
export function InstallationAuditSection() {
  const { t } = useTranslation();
  return (
    <AuditLog
      id="ops-installation-audit-title"
      title={t("ops.audit.installationTitle")}
      description={t("ops.audit.installationDescription")}
      audit={useInstallationAudit()}
      extra={
        // The whole log, installation and every office, for an auditor (R-SEC-5).
        <>
          <a
            href="/api/admin/audit/export?format=csv"
            download
            className={buttonClasses("outline", "sm")}
          >
            <Download aria-hidden />
            {t("ops.audit.exportCsv")}
          </a>
          <a
            href="/api/admin/audit/export?format=jsonl"
            download
            className={buttonClasses("outline", "sm")}
          >
            <Download aria-hidden />
            {t("ops.audit.exportJsonl")}
          </a>
        </>
      }
    />
  );
}

function AuditLog({
  id,
  title,
  description,
  audit,
  extra,
}: {
  id: string;
  title: string;
  description: string;
  audit: ReturnType<typeof useOpsAudit>;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const colleagueName = useColleagueRefName();

  return (
    <section aria-labelledby={id} className="space-y-4">
      <SectionHeader
        id={id}
        title={title}
        description={description}
        action={
          <div className="flex flex-wrap gap-2">
            {extra}
            <Button
              size="sm"
              variant="outline"
              disabled={audit.isFetching}
              onClick={() => void audit.refetch()}
            >
              {audit.isFetching ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              {t("ops.refresh")}
            </Button>
          </div>
        }
      />

      {audit.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : audit.isError ? (
        <ErrorAlert>{translateError(t, audit.error)}</ErrorAlert>
      ) : audit.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("ops.audit.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("ops.audit.time")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("ops.audit.actor")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("ops.audit.action")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("ops.audit.target")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("ops.audit.detail")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {audit.data.map((entry) => (
                <tr key={entry.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {entry.actor ? (
                      <span className="flex items-center gap-1.5">
                        {entry.actor.kind === "colleague" ? (
                          <Bot className="size-3.5 text-primary" aria-hidden />
                        ) : (
                          <User className="size-3.5 text-muted-foreground" aria-hidden />
                        )}
                        <span className="sr-only">
                          {t(`ops.audit.actorKinds.${entry.actor.kind}`)}
                        </span>
                        {entry.actor.kind === "colleague"
                          ? colleagueName(entry.actor)
                          : entry.actor.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("ops.audit.system")}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{entry.action}</td>
                  <td className="px-3 py-2 break-all">{entry.target ?? "—"}</td>
                  <td className="max-w-xs px-3 py-2">
                    {entry.detail ? (
                      <code className="line-clamp-3 font-mono text-xs break-all text-muted-foreground">
                        {JSON.stringify(entry.detail)}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
