import { isSmtpSecurity, SMTP_SECURITY, type SmtpSecurity, type SmtpSettings } from "@orlok/shared";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select } from "@/components/ui/select";
import { TelegramBotCard } from "@/features/admin/TelegramBotCard";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useSaveSmtp, useSmtpSettings, useTestSmtp } from "@/lib/admin-queries";
import { useMe } from "@/lib/queries";

function SmtpForm({ settings }: { settings: SmtpSettings | null }) {
  const { t } = useTranslation();
  const save = useSaveSmtp();
  const [host, setHost] = useState(settings?.host ?? "");
  const [port, setPort] = useState(String(settings?.port ?? 587));
  const [security, setSecurity] = useState<SmtpSecurity>(settings?.security ?? "starttls");
  const [username, setUsername] = useState(settings?.username ?? "");
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [fromAddress, setFromAddress] = useState(settings?.fromAddress ?? "");
  const [fromName, setFromName] = useState(settings?.fromName ?? "Orlok");
  const [saved, setSaved] = useState(false);

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const hasPassword = save.data?.hasPassword ?? settings?.hasPassword ?? false;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    save.mutate(
      {
        host,
        // An invalid number is sent as-is so the server reports it on the field.
        port: Number(port),
        security,
        username: username.trim() || null,
        fromAddress,
        fromName: fromName.trim() || null,
        ...(removePassword ? { password: null } : password ? { password } : {}),
      },
      {
        onSuccess: () => {
          setPassword("");
          setRemovePassword(false);
          setSaved(true);
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <FormField id="smtp-host" label={t("email.host")} error={errors.host}>
            <Input
              id="smtp-host"
              required
              placeholder="smtp.example.com"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              aria-invalid={Boolean(errors.host)}
            />
          </FormField>
        </div>
        <div className="sm:col-span-1">
          <FormField id="smtp-port" label={t("email.port")} error={errors.port}>
            <Input
              id="smtp-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65_535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              aria-invalid={Boolean(errors.port)}
            />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          <FormField id="smtp-security" label={t("email.security")}>
            <Select
              id="smtp-security"
              value={security}
              onChange={(event) => {
                if (isSmtpSecurity(event.target.value)) {
                  setSecurity(event.target.value);
                }
              }}
            >
              {SMTP_SECURITY.map((value) => (
                <option key={value} value={value}>
                  {t(`email.securityOptions.${value}`)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="sm:col-span-3">
          <FormField
            id="smtp-username"
            label={t("email.username")}
            error={errors.username}
            hint={t("email.usernameHint")}
          >
            <Input
              id="smtp-username"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-describedby="smtp-username-message"
            />
          </FormField>
        </div>
        <div className="sm:col-span-3">
          <FormField
            id="smtp-password"
            label={t("email.password")}
            error={errors.password}
            hint={hasPassword ? t("email.passwordKeep") : undefined}
          >
            <PasswordInput
              id="smtp-password"
              autoComplete="new-password"
              value={password}
              disabled={removePassword}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>
          {hasPassword ? (
            <div className="mt-2">
              <CheckboxField
                label={t("email.removePassword")}
                checked={removePassword}
                onChange={(event) => setRemovePassword(event.target.checked)}
              />
            </div>
          ) : null}
        </div>

        <div className="sm:col-span-3">
          <FormField id="smtp-from" label={t("email.fromAddress")} error={errors.fromAddress}>
            <Input
              id="smtp-from"
              type="email"
              required
              placeholder="orlok@example.com"
              value={fromAddress}
              onChange={(event) => setFromAddress(event.target.value)}
              aria-invalid={Boolean(errors.fromAddress)}
            />
          </FormField>
        </div>
        <div className="sm:col-span-3">
          <FormField id="smtp-from-name" label={t("email.fromName")} error={errors.fromName}>
            <Input
              id="smtp-from-name"
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
            />
          </FormField>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {saved ? (
          <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("email.saved")}
          </p>
        ) : null}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("email.save")}
        </Button>
      </div>
    </form>
  );
}

function SmtpTest({ configured }: { configured: boolean }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const test = useTestSmtp();
  const [to, setTo] = useState(me?.email ?? "");

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        test.mutate(to);
      }}
    >
      <div className="space-y-1">
        <h2 className="font-semibold">{t("email.testTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {configured ? t("email.testDescription") : t("email.notConfigured")}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2 sm:flex-nowrap">
        <div className="w-full">
          <FormField id="smtp-test-to" label={t("email.testTo")}>
            <Input
              id="smtp-test-to"
              type="email"
              value={to}
              disabled={!configured}
              onChange={(event) => setTo(event.target.value)}
            />
          </FormField>
        </div>
        <Button type="submit" variant="outline" disabled={!configured || !to || test.isPending}>
          {test.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          {t("email.testSend")}
        </Button>
      </div>
      {test.data?.ok ? (
        <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {t("email.testOk")}
        </p>
      ) : null}
      {test.data && !test.data.ok ? (
        <ErrorAlert>{t("email.testFailed", { message: test.data.message })}</ErrorAlert>
      ) : null}
      {test.isError ? <ErrorAlert>{translateError(t, test.error)}</ErrorAlert> : null}
    </form>
  );
}

// SMTP settings (R-ADM-7).
export function EmailPage() {
  const { t } = useTranslation();
  const settings = useSmtpSettings();

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("email.title")}</h1>
        <p className="text-muted-foreground">{t("email.description")}</p>
      </div>
      {settings.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : settings.isError ? (
        <ErrorAlert>{translateError(t, settings.error)}</ErrorAlert>
      ) : (
        <>
          <Card className="p-4">
            <SmtpForm settings={settings.data} />
          </Card>
          <Card className="p-4">
            <SmtpTest configured={settings.data !== null} />
          </Card>
          <TelegramBotCard />
        </>
      )}
    </>
  );
}
