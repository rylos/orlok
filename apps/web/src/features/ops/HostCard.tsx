import type { OpsHost } from "@orlok/shared";
import { Pencil, Server, ShieldCheck, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { translateError } from "@/i18n/errors";
import { useDeleteHost, useSaveHost } from "@/lib/ops-admin-queries";
import { hostKeyType } from "./format";

export function HostCard({
  host,
  sameAddress,
  onEdit,
}: {
  host: OpsHost;
  sameAddress: OpsHost[];
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveHost();
  const remove = useDeleteHost();
  const error = save.error ?? remove.error;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-4 text-primary" aria-hidden />
            <span className="font-medium break-all">{host.name}</span>
            <Badge variant="primary">{t(`ops.hosts.kinds.${host.kind}`)}</Badge>
            {host.enabled ? null : <Badge>{t("ops.hosts.disabled")}</Badge>}
            {sameAddress.length > 0 ? (
              <Badge variant="warning" title={sameAddress.map((other) => other.name).join(", ")}>
                <TriangleAlert className="size-3.5" aria-hidden />
                {t("ops.hosts.sameAddress", { names: sameAddress.map((o) => o.name).join(", ") })}
              </Badge>
            ) : null}
            {host.connection !== "ssh" ? (
              // WinRM has no SSH host key: http is protected by NTLM or Kerberos, https by its
              // certificate.
              <Badge>{t(`ops.hosts.connections.${host.connection}`)}</Badge>
            ) : host.hostKey ? (
              <Badge variant="success" title={host.hostKey}>
                <ShieldCheck className="size-3.5" aria-hidden />
                {t("ops.hosts.hostKeyTrusted", { type: hostKeyType(host.hostKey) })}
              </Badge>
            ) : (
              <Badge>
                <ShieldOff className="size-3.5" aria-hidden />
                {t("ops.hosts.hostKeyUnknown")}
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">
            {host.address}:{host.port}
          </p>
          {host.description ? (
            <p className="text-sm text-muted-foreground">{host.description}</p>
          ) : null}
          {host.tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label={t("ops.hosts.tags")}>
              {host.tags.map((tag) => (
                <li key={tag}>
                  <Badge>{tag}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil aria-hidden />
            {t("common.edit")}
          </Button>
          {host.hostKey ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                if (window.confirm(t("ops.hosts.forgetHostKeyConfirm", { name: host.name }))) {
                  save.mutate({ id: host.id, input: { resetHostKey: true } });
                }
              }}
            >
              <ShieldOff aria-hidden />
              {t("ops.hosts.forgetHostKey")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("ops.hosts.deleteConfirm", { name: host.name }))) {
                remove.mutate(host.id);
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
    </Card>
  );
}
