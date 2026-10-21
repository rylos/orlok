import {
  CREDENTIAL_KINDS,
  type Credential,
  type CredentialKind,
  type OpsHost,
} from "@orlok/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { type CredentialInput, useSaveCredential } from "@/lib/credential-queries";
import { cn } from "@/lib/utils";

type CredentialFormProps = {
  credential?: Credential;
  hosts: OpsHost[];
  // Hosts already used by the person's other credentials, with that credential's name.
  taken: Map<string, string>;
  // With the stored credential when it was saved, without when the form was cancelled.
  onDone: (saved?: Credential) => void;
};

function isCredentialKind(value: string): value is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

// One of the person's own credentials and the hosts it is used on (R-OPS-3). The secret is
// write-only: when editing, an empty field keeps the stored one.
export function CredentialForm({ credential, hosts, taken, onDone }: CredentialFormProps) {
  const { t } = useTranslation();
  const save = useSaveCredential();
  const [name, setName] = useState(credential?.name ?? "");
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? "password");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [description, setDescription] = useState(credential?.description ?? "");
  const [hostIds, setHostIds] = useState<string[]>(credential?.hostIds ?? []);

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `credential-${credential?.id ?? "new"}-${field}`;
  const secretHint = credential ? t("ops.credentials.secretKeep") : undefined;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const common = {
      name,
      username: username.trim() || null,
      description: description.trim() || null,
      // A token is not used on hosts.
      ...(kind === "token" ? {} : { hostIds }),
    };
    let input: CredentialInput;
    if (credential) {
      input = {
        ...common,
        ...(secret ? { secret } : {}),
        ...(kind === "ssh_key" && passphrase ? { passphrase } : {}),
      };
    } else {
      input = {
        ...common,
        kind,
        secret,
        passphrase: kind === "ssh_key" && passphrase ? passphrase : null,
      };
    }
    save.mutate({ id: credential?.id, input }, { onSuccess: (saved) => onDone(saved) });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={KeyRound}>
        {credential ? t("common.editing", { name: credential.name }) : t("ops.credentials.add")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("name")} label={t("ops.credentials.name")} error={errors.name}>
          <Input
            id={id("name")}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.name)}
          />
        </FormField>

        <FormField
          id={id("kind")}
          label={t("ops.credentials.kind")}
          error={errors.kind}
          hint={credential ? t("ops.credentials.kindFixed") : undefined}
        >
          <Select
            id={id("kind")}
            value={kind}
            disabled={Boolean(credential)}
            onChange={(e) => {
              if (isCredentialKind(e.target.value)) {
                setKind(e.target.value);
              }
            }}
          >
            {CREDENTIAL_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`ops.credentials.kinds.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id={id("username")}
          label={t("ops.credentials.username")}
          error={errors.username}
          hint={t("ops.credentials.usernameHint")}
        >
          <Input
            id={id("username")}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={Boolean(errors.username)}
          />
        </FormField>

        {kind === "ssh_key" ? (
          <FormField
            id={id("passphrase")}
            label={t("ops.credentials.passphrase")}
            error={errors.passphrase}
            hint={credential ? t("ops.credentials.secretKeep") : t("ops.credentials.optional")}
          >
            <PasswordInput
              id={id("passphrase")}
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              aria-invalid={Boolean(errors.passphrase)}
            />
          </FormField>
        ) : null}

        <div className="sm:col-span-2">
          <FormField
            id={id("secret")}
            label={t(`ops.credentials.secretLabel.${kind}`)}
            error={errors.secret}
            hint={secretHint}
          >
            {kind === "ssh_key" ? (
              <Textarea
                id={id("secret")}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                aria-invalid={Boolean(errors.secret)}
              />
            ) : (
              <PasswordInput
                id={id("secret")}
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                aria-invalid={Boolean(errors.secret)}
              />
            )}
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <FormField
            id={id("description")}
            label={t("ops.credentials.descriptionLabel")}
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

      {kind === "token" ? (
        <p className="text-sm text-muted-foreground">{t("ops.credentials.tokenHint")}</p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t("ops.credentials.hosts")}</legend>
          <p className="text-sm text-muted-foreground">{t("ops.credentials.hostsHint")}</p>
          {hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("ops.credentials.noHosts")}</p>
          ) : (
            <ul className="divide-y rounded-md border bg-background">
              {hosts.map((host) => {
                const usedBy = taken.get(host.id);
                return (
                  <li
                    key={host.id}
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-2 px-3 py-2",
                      usedBy !== undefined && "text-muted-foreground",
                    )}
                  >
                    <CheckboxField
                      label={
                        <span>
                          <span className="font-medium">{host.name}</span>{" "}
                          <span className="font-mono text-xs text-muted-foreground">
                            {host.address}:{host.port}
                          </span>
                        </span>
                      }
                      checked={hostIds.includes(host.id)}
                      disabled={usedBy !== undefined}
                      onChange={(event) =>
                        setHostIds((current) =>
                          event.target.checked
                            ? [...current, host.id]
                            : current.filter((id) => id !== host.id),
                        )
                      }
                    />
                    <span className="flex flex-wrap items-center gap-1">
                      {usedBy !== undefined ? (
                        <span className="text-xs text-muted-foreground">
                          {t("ops.credentials.usedBy", { name: usedBy })}
                        </span>
                      ) : null}
                      <Badge>{t(`ops.hosts.kinds.${host.kind}`)}</Badge>
                      {host.enabled ? null : <Badge>{t("ops.hosts.disabled")}</Badge>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {errors.hostIds ? <p className="text-sm text-destructive">{errors.hostIds}</p> : null}
        </fieldset>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("ops.credentials.save")}
        </Button>
      </div>
    </form>
  );
}
