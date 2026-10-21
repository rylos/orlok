import type { Credential, OpsHost } from "@orlok/shared";
import {
  Clock,
  KeyRound,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Server,
  Trash2,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { formatDateTime } from "@/features/ops/format";
import { TestResult } from "@/features/ops/TestResult";
import { translateError } from "@/i18n/errors";
import {
  useDeleteCredential,
  useHostChoices,
  useMyCredentials,
  useTestCredential,
} from "@/lib/credential-queries";
import { CredentialForm } from "./CredentialForm";

// One host of a credential, with a way to check that it really gets in, and as whom. Right after
// the credential is saved the check runs by itself, so a wrong password shows up at once, to the
// person who can fix it, and not later in a conversation.
function HostRow({
  credentialId,
  host,
  autoTest,
}: {
  credentialId: string;
  host: OpsHost;
  autoTest: boolean;
}) {
  const { t } = useTranslation();
  const test = useTestCredential(credentialId);
  const { mutate } = test;
  useEffect(() => {
    if (autoTest && host.enabled) {
      mutate(host.id);
    }
  }, [autoTest, host.enabled, host.id, mutate]);

  return (
    <li className="space-y-2 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Server className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="font-medium break-all">{host.name}</span>
          <span className="font-mono text-xs break-all text-muted-foreground">
            {host.address}:{host.port}
          </span>
          {host.enabled ? null : <Badge>{t("ops.hosts.disabled")}</Badge>}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={test.isPending}
          onClick={() => test.mutate(host.id)}
        >
          {test.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <PlugZap aria-hidden />
          )}
          {t("ops.hosts.test")}
        </Button>
      </div>
      {test.isError ? <ErrorAlert>{translateError(t, test.error)}</ErrorAlert> : null}
      {test.data && !test.isPending ? <TestResult result={test.data} /> : null}
    </li>
  );
}

function CredentialCard({
  credential,
  hosts,
  autoTest,
  onAutoTested,
  onEdit,
}: {
  credential: Credential;
  hosts: OpsHost[];
  autoTest: boolean;
  onAutoTested: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  // The host rows start their checks first (children's effects run before their parent's): then
  // the request is spent, so reopening and cancelling the form does not test again.
  useEffect(() => {
    if (autoTest) {
      onAutoTested();
    }
  }, [autoTest, onAutoTested]);
  const remove = useDeleteCredential();
  const used = credential.hostIds
    .map((id) => hosts.find((host) => host.id === id))
    .filter((host) => host !== undefined);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            <span className="font-medium break-all">{credential.name}</span>
            <Badge variant="primary">{t(`ops.credentials.kinds.${credential.kind}`)}</Badge>
          </div>
          {credential.description ? (
            <p className="text-sm text-muted-foreground">{credential.description}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {credential.username ? (
              <span className="flex items-center gap-1.5">
                <User className="size-3.5" aria-hidden />
                <span className="sr-only">{t("ops.credentials.username")}</span>
                <span className="font-mono break-all">{credential.username}</span>
              </span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden />
              {credential.lastUsedAt
                ? t("ops.credentials.lastUsed", { date: formatDateTime(credential.lastUsedAt) })
                : t("ops.credentials.neverUsed")}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil aria-hidden />
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("ops.credentials.deleteConfirm", { name: credential.name }))) {
                remove.mutate(credential.id);
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </div>
      {credential.kind === "token" ? null : used.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("ops.credentials.notUsed")}</p>
      ) : (
        <ul className="divide-y" aria-label={t("ops.credentials.hosts")}>
          {used.map((host) => (
            <HostRow key={host.id} credentialId={credential.id} host={host} autoTest={autoTest} />
          ))}
        </ul>
      )}
      {remove.isError ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}
    </Card>
  );
}

// The person's own credentials (R-OPS-3): colleagues working for them use the one stored for a
// host, so they can do there what the person can and nothing more. Secrets are never shown.
export function CredentialsSection() {
  const { t } = useTranslation();
  const credentials = useMyCredentials();
  const hosts = useHostChoices();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The credential just saved, whose hosts are checked as soon as its card is back.
  const [toTest, setToTest] = useState<string | null>(null);
  const tested = () => setToTest(null);
  const hostList = hosts.data ?? [];
  // Hosts already used by another credential, which the one being edited cannot take.
  const takenBy = (credentialId: string | null) =>
    new Map(
      (credentials.data ?? [])
        .filter((credential) => credential.id !== credentialId)
        .flatMap((credential) => credential.hostIds.map((id) => [id, credential.name] as const)),
    );

  return (
    <section aria-labelledby="account-credentials-title" className="space-y-4">
      <SectionHeader
        id="account-credentials-title"
        title={t("ops.credentials.title")}
        description={t("ops.credentials.description")}
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
              {t("ops.credentials.add")}
            </Button>
          )
        }
      />

      {creating ? (
        <Card className="p-4">
          <CredentialForm
            hosts={hostList}
            taken={takenBy(null)}
            onDone={(saved) => {
              setCreating(false);
              setToTest(saved?.id ?? null);
            }}
          />
        </Card>
      ) : null}

      {hosts.isError ? <ErrorAlert>{translateError(t, hosts.error)}</ErrorAlert> : null}
      {credentials.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : credentials.isError ? (
        <ErrorAlert>{translateError(t, credentials.error)}</ErrorAlert>
      ) : credentials.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("ops.credentials.empty")}
          </p>
        )
      ) : (
        <ul className="grid gap-3">
          {credentials.data.map((credential) => (
            <li key={credential.id}>
              {editingId === credential.id ? (
                <Card className="p-4">
                  <CredentialForm
                    credential={credential}
                    hosts={hostList}
                    taken={takenBy(credential.id)}
                    onDone={(saved) => {
                      setEditingId(null);
                      setToTest(saved?.id ?? null);
                    }}
                  />
                </Card>
              ) : (
                <CredentialCard
                  credential={credential}
                  hosts={hostList}
                  autoTest={toTest === credential.id}
                  onAutoTested={tested}
                  onEdit={() => {
                    setEditingId(credential.id);
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
