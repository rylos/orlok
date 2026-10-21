import {
  MCP_TOOL_POLICIES,
  MCP_TRANSPORTS,
  type McpCatalogEntry,
  type McpServer,
  type McpToolPolicy,
  type McpTransport,
} from "@orlok/shared";
import { Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { type McpServerInput, useSaveMcpServer } from "@/lib/ops-admin-queries";
import { localId } from "@/lib/utils";

type SecretDraft = { key: string; name: string; value: string; stored: boolean };

function isTransport(value: string): value is McpTransport {
  return (MCP_TRANSPORTS as readonly string[]).includes(value);
}

function isToolPolicy(value: string): value is McpToolPolicy {
  return (MCP_TOOL_POLICIES as readonly string[]).includes(value);
}

type McpServerFormProps = {
  officeId: string;
  server?: McpServer;
  // Chosen from the catalog: fills in the connection and the credentials to ask for (R-OPS-15).
  preset?: McpCatalogEntry;
  onDone: () => void;
};

// MCP server of an office (R-OPS-10). Secret values are write-only.
export function McpServerForm({ officeId, server, preset, onDone }: McpServerFormProps) {
  const { t } = useTranslation();
  const save = useSaveMcpServer(officeId);
  const [name, setName] = useState(server?.name ?? preset?.id ?? "");
  const [transport, setTransport] = useState<McpTransport>(
    server?.transport ?? preset?.transport ?? "http",
  );
  const [url, setUrl] = useState(server?.url ?? preset?.url ?? "");
  const [command, setCommand] = useState(server?.command ?? preset?.command ?? "");
  const [args, setArgs] = useState(server?.args.join("\n") ?? preset?.args?.join("\n") ?? "");
  const [secrets, setSecrets] = useState<SecretDraft[]>(
    () =>
      server?.secretNames.map((secretName) => ({
        key: localId(),
        name: secretName,
        value: "",
        stored: true,
      })) ??
      preset?.fields.map((field) => ({
        key: localId(),
        name: field.name,
        value: field.default ?? "",
        stored: false,
      })) ??
      [],
  );
  const [toolPolicy, setToolPolicy] = useState<McpToolPolicy>(
    server?.toolPolicy ?? preset?.toolPolicy ?? "readonly_auto",
  );
  const [description, setDescription] = useState(server?.description ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  // Null: every tool of the server. Known once the server has been reached at least once.
  const [allowedTools, setAllowedTools] = useState<string[] | null>(
    server?.allowedTools ?? preset?.tools ?? null,
  );

  const errors = translateFieldErrors(t, save.error);
  const secretsError = Object.entries(errors).find(([path]) => path.startsWith("secrets"))?.[1];
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `mcp-${server?.id ?? "new"}-${field}`;

  function updateSecret(key: string, patch: Partial<SecretDraft>) {
    setSecrets((current) =>
      current.map((secret) => (secret.key === key ? { ...secret, ...patch } : secret)),
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secretValues: Record<string, string | null> = {};
    for (const secret of secrets) {
      const secretName = secret.name.trim();
      if (secretName && (secret.value || !secret.stored)) {
        secretValues[secretName] = secret.value;
      }
    }
    // Stored secrets that were removed or renamed are deleted.
    for (const stored of server?.secretNames ?? []) {
      if (!secrets.some((secret) => secret.stored && secret.name.trim() === stored)) {
        secretValues[stored] ??= null;
      }
    }
    const common = {
      description: description.trim() || null,
      url: transport === "http" ? url.trim() || null : null,
      command: transport === "stdio" ? command.trim() || null : null,
      args:
        transport === "stdio"
          ? args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean)
          : [],
      toolPolicy,
      enabled,
      allowedTools,
    };
    const input: McpServerInput = server
      ? { ...common, ...(Object.keys(secretValues).length > 0 ? { secrets: secretValues } : {}) }
      : {
          ...common,
          name: name.trim(),
          transport,
          secrets: Object.fromEntries(
            Object.entries(secretValues).filter(
              (entry): entry is [string, string] => entry[1] !== null,
            ),
          ),
        };
    save.mutate({ id: server?.id, input }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}
      {preset ? (
        <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{preset.name}</p>
          <p className="text-muted-foreground">
            {t(`ops.mcp.catalog.entries.${preset.id}.description`)}
          </p>
          {preset.downloadsOnFirstRun ? (
            <p className="text-warning">{t("ops.mcp.catalog.downloads")}</p>
          ) : null}
          {preset.documentationUrl ? (
            <a
              href={preset.documentationUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {t("ops.mcp.catalog.documentation")}
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={id("name")}
          label={t("ops.mcp.name")}
          error={errors.name}
          hint={server ? undefined : t("ops.mcp.nameHint")}
        >
          <Input
            id={id("name")}
            required
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="proxmox"
            disabled={Boolean(server)}
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            aria-invalid={Boolean(errors.name)}
          />
        </FormField>

        <FormField id={id("transport")} label={t("ops.mcp.transport")} error={errors.transport}>
          <Select
            id={id("transport")}
            value={transport}
            disabled={Boolean(server)}
            onChange={(e) => {
              if (isTransport(e.target.value)) {
                setTransport(e.target.value);
              }
            }}
          >
            {MCP_TRANSPORTS.map((value) => (
              <option key={value} value={value}>
                {t(`ops.mcp.transports.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        {transport === "http" ? (
          <div className="sm:col-span-2">
            <FormField id={id("url")} label={t("ops.mcp.url")} error={errors.url}>
              <Input
                id={id("url")}
                type="url"
                required
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://mcp.example.local/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={Boolean(errors.url)}
              />
            </FormField>
          </div>
        ) : (
          <>
            <FormField
              id={id("command")}
              label={t("ops.mcp.command")}
              error={errors.command}
              hint={t("ops.mcp.commandHint")}
            >
              <Input
                id={id("command")}
                required
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="uvx"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                aria-invalid={Boolean(errors.command)}
              />
            </FormField>
            <FormField
              id={id("args")}
              label={t("ops.mcp.args")}
              error={errors.args}
              hint={t("ops.mcp.argsHint")}
            >
              <Textarea
                id={id("args")}
                rows={3}
                className="font-mono"
                spellCheck={false}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                aria-invalid={Boolean(errors.args)}
              />
            </FormField>
          </>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("ops.mcp.secrets")}</legend>
        <p className="text-sm text-muted-foreground">
          {transport === "http" ? t("ops.mcp.secretsHintHttp") : t("ops.mcp.secretsHintStdio")}
        </p>
        {secrets.length > 0 ? (
          <ul className="space-y-2">
            {secrets.map((secret) => (
              <li key={secret.key} className="grid gap-2 sm:grid-cols-[14rem_1fr_auto]">
                <Input
                  aria-label={t("ops.mcp.secretName")}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={transport === "http" ? "Authorization" : "API_TOKEN"}
                  value={secret.name}
                  disabled={secret.stored}
                  onChange={(e) => updateSecret(secret.key, { name: e.target.value })}
                />
                <PasswordInput
                  aria-label={t("ops.mcp.secretValue")}
                  autoComplete="new-password"
                  placeholder={secret.stored ? t("ops.mcp.secretStored") : undefined}
                  value={secret.value}
                  onChange={(e) => updateSecret(secret.key, { value: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="destructive"
                  aria-label={t("ops.mcp.removeSecret")}
                  onClick={() =>
                    setSecrets((current) => current.filter((item) => item.key !== secret.key))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {secretsError ? <p className="text-sm text-destructive">{secretsError}</p> : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setSecrets((current) => [
              ...current,
              { key: localId(), name: "", value: "", stored: false },
            ])
          }
        >
          <Plus aria-hidden />
          {t("ops.mcp.addSecret")}
        </Button>
      </fieldset>

      <FormField id={id("toolPolicy")} label={t("ops.mcp.toolPolicy")} error={errors.toolPolicy}>
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

      {server && server.tools.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("ops.mcp.allowedTools")}</legend>
          <p className="text-sm text-muted-foreground">{t("ops.mcp.allowedToolsHint")}</p>
          <CheckboxField
            label={t("ops.mcp.allTools", { count: server.tools.length })}
            checked={allowedTools === null}
            onChange={(e) =>
              setAllowedTools(e.target.checked ? null : server.tools.map((tool) => tool.name))
            }
          />
          {allowedTools !== null ? (
            <ul className="max-h-64 space-y-1 overflow-auto rounded-md border p-2">
              {server.tools.map((tool) => (
                <li key={tool.name}>
                  <CheckboxField
                    label={tool.name}
                    checked={allowedTools.includes(tool.name)}
                    onChange={(e) =>
                      setAllowedTools((current) =>
                        e.target.checked
                          ? [...(current ?? []), tool.name]
                          : (current ?? []).filter((name) => name !== tool.name),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
      ) : null}

      <FormField
        id={id("description")}
        label={t("ops.mcp.descriptionLabel")}
        error={errors.description}
      >
        <Input
          id={id("description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={Boolean(errors.description)}
        />
      </FormField>

      <CheckboxField
        label={t("ops.mcp.enabled")}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />

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
