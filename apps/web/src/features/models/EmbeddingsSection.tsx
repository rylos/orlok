import {
  EMBEDDING_MODES,
  type EmbeddingMode,
  type EmbeddingOverview,
  type EmbeddingSettings,
} from "@orlok/shared";
import { CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { formatNumber, translateError } from "@/i18n/errors";
import {
  useEmbeddingSettings,
  useProviders,
  useSaveEmbeddingSettings,
  useTestEmbeddings,
} from "@/lib/admin-queries";
import { cn } from "@/lib/utils";

function EmbeddingsForm({ overview }: { overview: EmbeddingOverview }) {
  const { t } = useTranslation();
  const providers = useProviders();
  const save = useSaveEmbeddingSettings();
  const test = useTestEmbeddings();
  const [mode, setMode] = useState<EmbeddingMode>(overview.mode);
  const [providerId, setProviderId] = useState(overview.providerId ?? "");
  const [model, setModel] = useState(overview.model ?? "");
  const [saved, setSaved] = useState(false);

  // Anthropic offers no embeddings API.
  const candidates = (providers.data ?? []).filter((provider) => provider.kind !== "anthropic");
  const selectedProvider = providerId || candidates[0]?.id || "";
  const input: EmbeddingSettings = {
    mode,
    providerId: mode === "provider" ? selectedProvider || null : null,
    model: mode === "provider" ? model.trim() || null : null,
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    save.mutate(input, { onSuccess: () => setSaved(true) });
  }

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setSaved(false);
      test.reset();
    };
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{t("models.embeddings.mode")}</legend>
        {EMBEDDING_MODES.map((value) => {
          const unavailable = value === "builtin" && !overview.builtinAvailable;
          return (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                mode === value && "border-primary bg-primary/5",
              )}
            >
              <input
                type="radio"
                name="embedding-mode"
                className="mt-1 accent-(--color-primary)"
                value={value}
                checked={mode === value}
                onChange={() => change(setMode)(value)}
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">
                  {t(`models.embeddings.modes.${value}`)}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t(`models.embeddings.modeHints.${value}`)}
                </span>
                {unavailable ? (
                  <span className="block text-sm text-destructive">
                    {t("models.embeddings.builtinMissing")}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>

      {mode === "provider" ? (
        candidates.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {t("models.embeddings.noProviders")}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="embeddings-provider" label={t("models.embeddings.provider")}>
              <Select
                id="embeddings-provider"
                value={selectedProvider}
                onChange={(event) => change(setProviderId)(event.target.value)}
              >
                {candidates.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="embeddings-model" label={t("models.embeddings.model")}>
              <Input
                id="embeddings-model"
                placeholder={t("models.embeddings.modelPlaceholder")}
                value={model}
                onChange={(event) => change(setModel)(event.target.value)}
              />
            </FormField>
          </div>
        )
      ) : null}

      {overview.mode !== "off" ? (
        <p className="text-sm text-muted-foreground">
          {t("models.embeddings.status", {
            indexed: formatNumber(overview.indexedPages),
            total: formatNumber(overview.totalPages),
          })}
          {" · "}
          {t("models.embeddings.reindexHint")}
        </p>
      ) : null}

      {overview.lastError ? (
        <ErrorAlert>
          {t("models.embeddings.indexingFailed", {
            message: overview.lastError.message,
            when: new Date(overview.lastError.at).toLocaleString(),
          })}
        </ErrorAlert>
      ) : null}

      {test.data ? (
        test.data.ok ? (
          <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("models.embeddings.testOk", { dimensions: test.data.dimensions })}
          </p>
        ) : (
          <ErrorAlert>
            {t("models.embeddings.testFailed", { message: test.data.message })}
          </ErrorAlert>
        )
      ) : null}
      {test.isError || save.isError ? (
        <ErrorAlert>{translateError(t, test.error ?? save.error)}</ErrorAlert>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {saved ? (
          <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("models.embeddings.saved")}
          </p>
        ) : null}
        {mode !== "off" ? (
          <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate(input)}>
            {test.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <FlaskConical aria-hidden />
            )}
            {t("models.embeddings.test")}
          </Button>
        ) : null}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("models.embeddings.save")}
        </Button>
      </div>
    </form>
  );
}

// Semantic memory: built-in embedding model, a provider, or off.
export function EmbeddingsSection() {
  const { t } = useTranslation();
  const settings = useEmbeddingSettings();

  return (
    <section aria-labelledby="embeddings-title" className="space-y-4">
      <SectionHeader
        id="embeddings-title"
        title={t("models.embeddings.title")}
        description={t("models.embeddings.description")}
      />
      <Card className="p-4">
        {settings.isPending ? (
          <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
        ) : settings.isError ? (
          <ErrorAlert>{translateError(t, settings.error)}</ErrorAlert>
        ) : (
          <EmbeddingsForm key={settings.data.mode} overview={settings.data} />
        )}
      </Card>
    </section>
  );
}
