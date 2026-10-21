import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { AuditSection, InstallationAuditSection } from "@/features/ops/AuditSection";
import { McpServersSection } from "@/features/ops/McpServersSection";
import { RunnerStatusCard } from "@/features/ops/RunnerStatusCard";
import { translateError } from "@/i18n/errors";
import { useAdminOffices } from "@/lib/admin-queries";

// Operations: runner and installation log, then per office MCP servers and audit (R-OPS,
// R-SEC-1). The host registry has its own page.
export function OpsPage() {
  const { t } = useTranslation();
  const offices = useAdminOffices();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const office =
    offices.data?.find((item) => item.id === selectedId) ?? offices.data?.[0] ?? undefined;

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("ops.title")}</h1>
        <p className="text-muted-foreground">{t("ops.description")}</p>
      </div>

      <RunnerStatusCard />
      <InstallationAuditSection />

      {offices.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : offices.isError ? (
        <ErrorAlert>{translateError(t, offices.error)}</ErrorAlert>
      ) : !office ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("ops.noOffices")}
        </p>
      ) : (
        <>
          <div className="max-w-sm">
            <FormField id="ops-office" label={t("ops.office")} hint={t("ops.officeHint")}>
              <Select
                id="ops-office"
                value={office.id}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-describedby="ops-office-message"
              >
                {offices.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <div key={office.id} className="space-y-10">
            <McpServersSection officeId={office.id} />
            <AuditSection officeId={office.id} />
          </div>
        </>
      )}
    </>
  );
}
