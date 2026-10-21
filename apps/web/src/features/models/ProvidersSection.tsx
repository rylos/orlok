import type { ModelProvider } from "@orlok/shared";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError } from "@/i18n/errors";
import { useDeleteProvider, useProviderModels, useProviders } from "@/lib/admin-queries";
import { ProviderForm } from "./ProviderForm";

function ProviderCard({ provider, onEdit }: { provider: ModelProvider; onEdit: () => void }) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const models = useProviderModels(provider.id, testing);
  const remove = useDeleteProvider();

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-4 text-primary" aria-hidden />
            <span className="font-medium">{provider.name}</span>
            <Badge variant="primary">{t(`models.providers.kinds.${provider.kind}`)}</Badge>
            {provider.enabled ? null : <Badge>{t("models.providers.disabled")}</Badge>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.baseUrl ?? t("models.providers.defaultEndpoint")}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" aria-hidden />
            {provider.hasApiKey
              ? t("models.providers.apiKeySaved")
              : t("models.providers.apiKeyMissing")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={models.isFetching}
            onClick={() => (testing ? void models.refetch() : setTesting(true))}
          >
            {models.isFetching ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <PlugZap aria-hidden />
            )}
            {t("models.providers.test")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil aria-hidden />
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("models.providers.deleteConfirm", { name: provider.name }))) {
                remove.mutate(provider.id);
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      {testing && models.data && !models.isFetching ? (
        models.data.ok ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("models.providers.testOk", { count: models.data.models.length })}
          </p>
        ) : (
          <ErrorAlert>
            {t("models.providers.testFailed", { message: models.data.message })}
          </ErrorAlert>
        )
      ) : null}
      {models.isError ? <ErrorAlert>{translateError(t, models.error)}</ErrorAlert> : null}
      {remove.isError ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}
    </Card>
  );
}

export function ProvidersSection() {
  const { t } = useTranslation();
  const providers = useProviders();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <section aria-labelledby="providers-title" className="space-y-4">
      <SectionHeader
        id="providers-title"
        title={t("models.providers.title")}
        description={t("models.providers.description")}
        action={
          creating ? null : (
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
                setEditingId(null);
              }}
            >
              <Plus aria-hidden />
              {t("models.providers.add")}
            </Button>
          )
        }
      />

      {creating ? (
        <Card className="p-4">
          <ProviderForm onDone={() => setCreating(false)} />
        </Card>
      ) : null}

      {providers.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : providers.isError ? (
        <ErrorAlert>{translateError(t, providers.error)}</ErrorAlert>
      ) : providers.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("models.providers.empty")}
          </p>
        )
      ) : (
        <ul className="grid gap-3">
          {providers.data.map((provider) => (
            <li key={provider.id}>
              {editingId === provider.id ? (
                <Card className="p-4">
                  <ProviderForm provider={provider} onDone={() => setEditingId(null)} />
                </Card>
              ) : (
                <ProviderCard
                  provider={provider}
                  onEdit={() => {
                    setEditingId(provider.id);
                    setCreating(false);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
