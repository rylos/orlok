import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_MAX_OUTPUT_TOKENS,
  EXEC_MODES,
  type ExecMode,
  MAX_OUTPUT_TOKENS_LIMIT,
  type ModelProfile,
  type ModelProvider,
} from "@orlok/shared";
import { Layers, Loader2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatNumber, translateError, translateFieldErrors } from "@/i18n/errors";
import { useProviderModels, useSaveProfile } from "@/lib/admin-queries";
import { cn } from "@/lib/utils";

type ProfileFormProps = {
  profile?: ModelProfile;
  providers: ModelProvider[];
  onDone: () => void;
};

// A profile is a model and a mode (R-MOD-2). Once created only its name changes, so editing
// shows the rest as it is.
export function ProfileForm({ profile, providers, onDone }: ProfileFormProps) {
  return profile ? (
    <RenameProfileForm profile={profile} providers={providers} onDone={onDone} />
  ) : (
    <CreateProfileForm providers={providers} onDone={onDone} />
  );
}

function CreateProfileForm({ providers, onDone }: Omit<ProfileFormProps, "profile">) {
  const { t } = useTranslation();
  const save = useSaveProfile();
  const [name, setName] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(
    providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id ?? "",
  );
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<ExecMode | null>(null);
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [contextWindow, setContextWindow] = useState("");
  const models = useProviderModels(providerId || null);

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `profile-new-${field}`;
  const suggestions = models.data?.ok ? models.data.models : [];
  const selected = suggestions.find((option) => option.id === model.trim());
  const modelLimit = selected?.maxOutputTokens ?? null;
  // The name follows the model and the mode until someone types their own.
  const suggestedName = [model.trim(), mode ? t(`profiles.modes.${mode}.label`) : ""]
    .filter(Boolean)
    .join(" · ");
  const shownName = name ?? suggestedName;
  // Anthropic and Ollama publish the window; the OpenAI API does not, and then it is typed here.
  const contextWindowHint = selected?.contextWindow
    ? t("profiles.contextWindowAuto", { max: formatNumber(selected.contextWindow) })
    : suggestions.length > 0
      ? t("profiles.contextWindowUnknown")
      : t("profiles.contextWindowHint");
  const maxOutputTokensHint = modelLimit
    ? t("profiles.modelLimitHint", { max: formatNumber(modelLimit) })
    : t("profiles.maxOutputTokensHint", { max: formatNumber(MAX_OUTPUT_TOKENS_LIMIT) });
  const modelHint =
    models.data && !models.data.ok ? t("profiles.modelsUnavailable") : t("profiles.modelHint");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(
      {
        input: {
          name: shownName,
          providerId,
          model,
          // A missing mode is sent as-is so the server reports it on the field.
          mode: mode as ExecMode,
          // An invalid number is sent as-is so the server reports it on the field.
          maxOutputTokens: Number(maxOutputTokens),
          contextWindow: contextWindow.trim() === "" ? null : Number(contextWindow),
        },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Layers}>{t("profiles.add")}</FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("provider")} label={t("profiles.provider")} error={errors.providerId}>
          <Select
            id={id("provider")}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            aria-invalid={Boolean(errors.providerId)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id={id("model")}
          label={t("profiles.model")}
          error={errors.model}
          hint={modelHint}
        >
          <div className="relative">
            <Input
              id={id("model")}
              required
              list={id("model-options")}
              autoComplete="off"
              className="font-mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-invalid={Boolean(errors.model)}
              aria-describedby={`${id("model")}-message`}
            />
            {models.isFetching ? (
              <Loader2
                className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : null}
          </div>
          <datalist id={id("model-options")}>
            {suggestions.map((option) => (
              <option key={option.id} value={option.id} />
            ))}
          </datalist>
        </FormField>
      </div>

      <ModeChoice mode={mode} onChange={setMode} error={errors.mode} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormField
            id={id("name")}
            label={t("profiles.name")}
            error={errors.name}
            hint={t("profiles.nameHint")}
          >
            <Input
              id={id("name")}
              required
              value={shownName}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={`${id("name")}-message`}
            />
          </FormField>
        </div>

        <FormField
          id={id("maxOutputTokens")}
          label={t("profiles.maxOutputTokens")}
          error={errors.maxOutputTokens}
          hint={maxOutputTokensHint}
        >
          <Input
            id={id("maxOutputTokens")}
            type="number"
            inputMode="numeric"
            min={1}
            max={modelLimit ?? MAX_OUTPUT_TOKENS_LIMIT}
            step={1000}
            value={maxOutputTokens}
            onChange={(e) => setMaxOutputTokens(e.target.value)}
            aria-invalid={Boolean(errors.maxOutputTokens)}
            aria-describedby={`${id("maxOutputTokens")}-message`}
          />
        </FormField>

        <FormField
          id={id("contextWindow")}
          label={t("profiles.contextWindow")}
          error={errors.contextWindow}
          hint={contextWindowHint}
        >
          <Input
            id={id("contextWindow")}
            type="number"
            inputMode="numeric"
            min={CONTEXT_WINDOW_MIN}
            max={CONTEXT_WINDOW_MAX}
            step={1000}
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            aria-invalid={Boolean(errors.contextWindow)}
            aria-describedby={`${id("contextWindow")}-message`}
          />
        </FormField>
      </div>

      <p className="text-sm text-muted-foreground">{t("profiles.fixed")}</p>

      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

function RenameProfileForm({
  profile,
  providers,
  onDone,
}: Required<Pick<ProfileFormProps, "profile">> & Omit<ProfileFormProps, "profile">) {
  const { t, i18n } = useTranslation();
  const save = useSaveProfile();
  const [name, setName] = useState(profile.name);
  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = `profile-${profile.id}-name`;
  const provider = providers.find((item) => item.id === profile.providerId);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ id: profile.id, input: { name } }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Layers}>{t("common.editing", { name: profile.name })}</FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <FormField id={id} label={t("profiles.name")} error={errors.name}>
        <Input
          id={id}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={Boolean(errors.name)}
        />
      </FormField>

      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t("profiles.model")}</dt>
        <dd className="font-mono break-all">
          {provider?.name ?? "—"} · {profile.model}
        </dd>
        <dt className="text-muted-foreground">{t("profiles.mode")}</dt>
        <dd>{t(`profiles.modes.${profile.mode}.label`)}</dd>
        <dt className="text-muted-foreground">{t("profiles.maxOutputTokens")}</dt>
        <dd>{profile.maxOutputTokens.toLocaleString(i18n.resolvedLanguage)}</dd>
        <dt className="text-muted-foreground">{t("profiles.contextWindow")}</dt>
        <dd>{profile.contextWindow?.toLocaleString(i18n.resolvedLanguage) ?? "—"}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">{t("profiles.fixed")}</p>

      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

function ModeChoice({
  mode,
  onChange,
  error,
}: {
  mode: ExecMode | null;
  onChange: (mode: ExecMode) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t("profiles.mode")}</legend>
      {EXEC_MODES.map((value) => (
        <label key={value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="profile-new-mode"
            value={value}
            checked={mode === value}
            onChange={() => onChange(value)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>
            <span className="font-medium">{t(`profiles.modes.${value}.label`)}</span>
            <span className="block text-muted-foreground">{t(`profiles.modes.${value}.hint`)}</span>
          </span>
        </label>
      ))}
      {mode === "full" || mode === "yolo" ? (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            mode === "yolo"
              ? "border-destructive/60 bg-destructive/10"
              : "border-warning/60 bg-warning/10",
          )}
        >
          <TriangleAlert
            className={cn(
              "mt-0.5 size-4 shrink-0",
              mode === "yolo" ? "text-destructive" : "text-warning",
            )}
            aria-hidden
          />
          <p>{t(mode === "yolo" ? "profiles.yoloWarning" : "profiles.fullWarning")}</p>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}

function FormActions({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t("profiles.save")}
      </Button>
    </div>
  );
}
