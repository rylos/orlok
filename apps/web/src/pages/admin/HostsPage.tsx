import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HostCard } from "@/features/ops/HostCard";
import { HostForm } from "@/features/ops/HostForm";
import { translateError } from "@/i18n/errors";
import { useHosts } from "@/lib/ops-admin-queries";

// Servers of the installation (R-OPS-1). People store their own credentials for them in their
// account, and colleagues reach a host only with the credential of the person they work for.
export function HostsPage() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("ops.hosts.title")}</h1>
          <p className="text-muted-foreground">{t("ops.hosts.description")}</p>
        </div>
        {creating ? null : (
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setEditingId(null);
            }}
          >
            <Plus aria-hidden />
            {t("ops.hosts.add")}
          </Button>
        )}
      </div>

      {creating ? (
        <Card className="p-4">
          <HostForm onDone={() => setCreating(false)} />
        </Card>
      ) : null}

      {hosts.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : hosts.isError ? (
        <ErrorAlert>{translateError(t, hosts.error)}</ErrorAlert>
      ) : hosts.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("ops.hosts.empty")}
          </p>
        )
      ) : (
        <ul className="grid gap-3">
          {hosts.data.map((host) => (
            <li key={host.id}>
              {editingId === host.id ? (
                <Card className="p-4">
                  <HostForm host={host} onDone={() => setEditingId(null)} />
                </Card>
              ) : (
                <HostCard
                  host={host}
                  sameAddress={(hosts.data ?? []).filter(
                    (other) =>
                      other.id !== host.id &&
                      other.address === host.address &&
                      other.port === host.port,
                  )}
                  onEdit={() => {
                    setEditingId(host.id);
                    setCreating(false);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
