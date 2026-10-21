import {
  isProviderKind,
  type ModelProvider,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@orlok/shared";
import { Cloud, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useSaveProvider } from "@/lib/admin-queries";

type ProviderFormProps = {
  provider?: ModelProvider;
  onDone: () => void;
};

export function ProviderForm({ provider, onDone }: ProviderFormProps) {
  const { t } = useTranslation();
  const save = useSaveProvider();
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `provider-${provider?.id ?? "new"}-${field}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = baseUrl.trim() || null;
    if (provider) {
      save.mutate(
        {
          id: provider.id,
          input: {
            name,
            baseUrl: url,
            enabled,
            ...(removeKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
          },
        },
        { onSuccess: onDone },
      );
    } else {
      save.mutate(
        { input: { name, kind, baseUrl: url, apiKey: apiKey || null, enabled } },
        { onSuccess: onDone },
      );
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Cloud}>
        {provider ? t("common.editing", { name: provider.name }) : t("models.providers.add")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("name")} label={t("models.providers.name")} error={errors.name}>
          <Input
            id={id("name")}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.name)}
          />
        </FormField>

        <FormField id={id("kind")} label={t("models.providers.kind")} error={errors.kind}>
          <Select
            id={id("kind")}
            value={kind}
            disabled={Boolean(provider)}
            onChange={(e) => {
              if (isProviderKind(e.target.value)) {
                setKind(e.target.value);
              }
            }}
          >
            {PROVIDER_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`models.providers.kinds.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <div className="sm:col-span-2">
          <FormField
            id={id("baseUrl")}
            label={t("models.providers.baseUrl")}
            error={errors.baseUrl}
            hint={t(`models.providers.baseUrlHint.${kind}`)}
          >
            <Input
              id={id("baseUrl")}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              aria-invalid={Boolean(errors.baseUrl)}
              aria-describedby={`${id("baseUrl")}-message`}
            />
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <FormField
            id={id("apiKey")}
            label={t("models.providers.apiKey")}
            error={errors.apiKey}
            hint={provider?.hasApiKey ? t("models.providers.apiKeyKeep") : undefined}
          >
            <PasswordInput
              id={id("apiKey")}
              autoComplete="off"
              value={apiKey}
              disabled={removeKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-invalid={Boolean(errors.apiKey)}
            />
          </FormField>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <CheckboxField
          label={t("models.providers.enabled")}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {provider?.hasApiKey ? (
          <CheckboxField
            label={t("models.providers.removeKey")}
            checked={removeKey}
            onChange={(e) => setRemoveKey(e.target.checked)}
          />
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("models.providers.save")}
        </Button>
      </div>
    </form>
  );
}
