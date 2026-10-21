import { MCP_TOOL_POLICIES, type McpCatalogEntry, type McpToolPolicy } from "@orlok/shared";
import { ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useSaveMcpServer } from "@/lib/ops-admin-queries";

function isToolPolicy(value: string): value is McpToolPolicy {
  return (MCP_TOOL_POLICIES as readonly string[]).includes(value);
}

type McpPresetFormProps = {
  officeId: string;
  preset: McpCatalogEntry;
  onDone: () => void;
  // The full form, for whoever needs a setting the catalog does not ask about.
  onManual: () => void;
};

// A tool from the catalog (R-OPS-15): someone who bought Orlok fills in what the tool asks for, in
// words, and every colleague of the office can use it. Commands, arguments and variable names stay
// out of the way.
export function McpPresetForm({ officeId, preset, onDone, onManual }: McpPresetFormProps) {
  const { t } = useTranslation();
  const save = useSaveMcpServer(officeId);
  // What people read about an entry lives in the translations, under its id. Not every entry
  // has every text (a guide, a policy explanation), so these keys are read loosely.
  const loose = t as unknown as (key: string, options?: Record<string, unknown>) => unknown;
  const base = `ops.mcp.catalog.entries.${preset.id}`;
  const text = (key: string) => String(loose(`${base}.${key}`, { defaultValue: "" }));
  const guide = loose(`${base}.guide`, { returnObjects: true, defaultValue: [] });
  const steps = Array.isArray(guide) ? guide.map(String) : [];
  const description = t(`ops.mcp.catalog.entries.${preset.id}.description`);

  const [name, setName] = useState<string>(preset.id);
  const [url, setUrl] = useState(preset.url ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(preset.fields.map((field) => [field.name, field.default ?? ""])),
  );
  const [toolPolicy, setToolPolicy] = useState<McpToolPolicy>(preset.toolPolicy);
  const [missing, setMissing] = useState<string[]>([]);

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `mcp-preset-${preset.id}-${field}`;
  const needsUrl = preset.transport === "http" && !preset.url;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const empty = preset.fields
      .filter((field) => !field.optional && !values[field.name]?.trim())
      .map((field) => field.name);
    setMissing(empty);
    if (empty.length > 0 || (needsUrl && !url.trim())) {
      return;
    }
    const secrets = Object.fromEntries(
      Object.entries(values)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value !== ""),
    );
    save.mutate(
      {
        input: {
          name: name.trim(),
          transport: preset.transport,
          url: preset.transport === "http" ? url.trim() || null : null,
          command: preset.transport === "stdio" ? (preset.command ?? null) : null,
          args: preset.transport === "stdio" ? (preset.args ?? []) : [],
          secrets,
          toolPolicy,
          enabled: true,
          description,
          allowedTools: preset.tools ?? null,
        },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="space-y-2">
        <h3 className="font-medium">{preset.name}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {preset.documentationUrl ? (
          <a
            href={preset.documentationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline"
          >
            {t("ops.mcp.catalog.documentation")}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </div>

      {steps.length > 0 ? (
        <section className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <h4 className="font-medium">{t("ops.mcp.catalog.guideTitle")}</h4>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            {steps.map((step) => (
              <li key={step} className="break-words">
                {step}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {preset.needsService ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {text("setup")}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {needsUrl ? (
          <div className="sm:col-span-2">
            <FormField id={id("url")} label={t("ops.mcp.url")} error={errors.url}>
              <Input
                id={id("url")}
                type="url"
                required
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://dbhub:8080/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={Boolean(errors.url)}
              />
            </FormField>
          </div>
        ) : null}
        {preset.fields.map((field) => {
          const label = text(`fields.${field.name}.label`) || field.name;
          const hint = text(`fields.${field.name}.hint`) || undefined;
          const error = missing.includes(field.name) ? t("issues.required") : undefined;
          const common = {
            id: id(field.name),
            value: values[field.name] ?? "",
            placeholder: field.placeholder,
            "aria-invalid": Boolean(error),
            onChange: (e: ChangeEvent<HTMLInputElement>) =>
              setValues((current) => ({ ...current, [field.name]: e.target.value })),
          };
          return (
            <FormField
              key={field.name}
              id={id(field.name)}
              label={field.optional ? `${label} ${t("ops.mcp.catalog.optional")}` : label}
              hint={hint}
              error={error}
            >
              {field.secret ? (
                <PasswordInput {...common} autoComplete="new-password" />
              ) : (
                <Input {...common} autoComplete="off" spellCheck={false} />
              )}
            </FormField>
          );
        })}
      </div>

      <FormField
        id={id("toolPolicy")}
        label={t("ops.mcp.toolPolicy")}
        hint={text("policy") || undefined}
        error={errors.toolPolicy}
      >
        <Select
          id={id("toolPolicy")}
          value={toolPolicy}
          onChange={(e) => {
            if (isToolPolicy(e.target.value)) {
              setToolPolicy(e.target.value);
            }
          }}
        >
          {MCP_TOOL_POLICIES.map((value) => (
            <option key={value} value={value}>
              {t(`ops.mcp.toolPolicies.${value}`)}
            </option>
          ))}
        </Select>
      </FormField>
      {toolPolicy === "allow_all" ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>{t("ops.mcp.allowAllWarning")}</p>
        </div>
      ) : null}

      {preset.downloadsOnFirstRun ? (
        <p className="text-sm text-warning">{t("ops.mcp.catalog.downloads")}</p>
      ) : null}

      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {t("ops.mcp.catalog.advanced")}
        </summary>
        <div className="mt-3 space-y-3">
          <FormField
            id={id("name")}
            label={t("ops.mcp.name")}
            error={errors.name}
            hint={t("ops.mcp.nameHint")}
          >
            <Input
              id={id("name")}
              required
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              aria-invalid={Boolean(errors.name)}
            />
          </FormField>
          {preset.transport === "stdio" ? (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {[preset.command, ...(preset.args ?? [])].join(" ")}
            </p>
          ) : null}
          {preset.tools ? (
            <p className="text-xs text-muted-foreground">
              {t("ops.mcp.catalog.onlyTools", { tools: preset.tools.join(", ") })}
            </p>
          ) : null}
          <Button size="sm" variant="outline" onClick={onManual}>
            {t("ops.mcp.catalog.manual")}
          </Button>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("ops.mcp.save")}
        </Button>
      </div>
    </form>
  );
}
