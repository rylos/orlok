import {
  DEFAULT_PORTS,
  HOST_CONNECTIONS,
  HOST_KINDS,
  type HostConnection,
  type HostKind,
  type OpsHost,
} from "@orlok/shared";
import { Loader2, Server } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useSaveHost } from "@/lib/ops-admin-queries";

type HostFormProps = {
  host?: OpsHost;
  onDone: () => void;
};

function isHostKind(value: string): value is HostKind {
  return (HOST_KINDS as readonly string[]).includes(value);
}

export function parseTags(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// Server of the installation reached through SSH, or WinRM for Windows (R-OPS-1, R-OPS-2).
export function HostForm({ host, onDone }: HostFormProps) {
  const { t } = useTranslation();
  const save = useSaveHost();
  const [name, setName] = useState(host?.name ?? "");
  const [kind, setKind] = useState<HostKind>(host?.kind ?? "linux");
  const [connection, setConnection] = useState<HostConnection>(host?.connection ?? "ssh");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [tags, setTags] = useState(host?.tags.join(", ") ?? "");
  const [description, setDescription] = useState(host?.description ?? "");
  const [enabled, setEnabled] = useState(host?.enabled ?? true);

  const errors = translateFieldErrors(t, save.error);
  const tagsError = Object.entries(errors).find(([path]) => path.startsWith("tags"))?.[1];
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `host-${host?.id ?? "new"}-${field}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const portNumber = Number(port);
    save.mutate(
      {
        id: host?.id,
        input: {
          name,
          kind,
          connection: kind === "windows" ? connection : "ssh",
          address,
          port: Number.isInteger(portNumber) && port.trim() ? portNumber : Number.NaN,
          tags: parseTags(tags),
          description: description.trim() || null,
          enabled,
        },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Server}>
        {host ? t("common.editing", { name: host.name }) : t("ops.hosts.add")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("name")} label={t("ops.hosts.name")} error={errors.name}>
          <Input
            id={id("name")}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.name)}
          />
        </FormField>

        <FormField id={id("kind")} label={t("ops.hosts.kind")} error={errors.kind}>
          <Select
            id={id("kind")}
            value={kind}
            onChange={(e) => {
              if (isHostKind(e.target.value)) {
                setKind(e.target.value);
                if (e.target.value !== "windows" && connection !== "ssh") {
                  setConnection("ssh");
                  setPort(String(DEFAULT_PORTS.ssh));
                }
              }
            }}
          >
            {HOST_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`ops.hosts.kinds.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        {kind === "windows" ? (
          <FormField
            id={id("connection")}
            label={t("ops.hosts.connection")}
            error={errors.connection}
            hint={t(`ops.hosts.connectionHints.${connection}`)}
          >
            <Select
              id={id("connection")}
              value={connection}
              aria-describedby={`${id("connection")}-message`}
              onChange={(e) => {
                const next = e.target.value as HostConnection;
                // The port follows the protocol unless it was set to something unusual.
                if (Object.values(DEFAULT_PORTS).includes(Number(port))) {
                  setPort(String(DEFAULT_PORTS[next]));
                }
                setConnection(next);
              }}
            >
              {HOST_CONNECTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`ops.hosts.connections.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}

        <FormField id={id("address")} label={t("ops.hosts.address")} error={errors.address}>
          <Input
            id={id("address")}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="web01.example.local"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-invalid={Boolean(errors.address)}
          />
        </FormField>

        <FormField
          id={id("port")}
          label={t(`ops.hosts.ports.${kind === "windows" ? connection : "ssh"}`)}
          error={errors.port}
        >
          <Input
            id={id("port")}
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            aria-invalid={Boolean(errors.port)}
          />
        </FormField>

        <FormField
          id={id("tags")}
          label={t("ops.hosts.tags")}
          error={tagsError}
          hint={t("ops.hosts.tagsHint")}
        >
          <Input
            id={id("tags")}
            autoComplete="off"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            aria-invalid={Boolean(tagsError)}
            aria-describedby={`${id("tags")}-message`}
          />
        </FormField>

        <div className="sm:col-span-2">
          <FormField
            id={id("description")}
            label={t("ops.hosts.descriptionLabel")}
            error={errors.description}
          >
            <Input
              id={id("description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={Boolean(errors.description)}
            />
          </FormField>
        </div>
      </div>

      <CheckboxField
        label={t("ops.hosts.enabled")}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("ops.hosts.save")}
        </Button>
      </div>
    </form>
  );
}
