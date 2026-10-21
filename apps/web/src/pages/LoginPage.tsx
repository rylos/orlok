import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { AuthLayout } from "@/layouts/AuthLayout";
import { useLogin, useSetupStatus } from "@/lib/queries";
import { sessionHasEnded } from "@/lib/session-ended";

export function LoginPage() {
  const { t } = useTranslation();
  const { data: status } = useSetupStatus();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // "Remember me" on by default: the session stays valid without asking to sign in again (R-AUTH-1).
  const [remember, setRemember] = useState(true);
  // Sent back here because the session ended elsewhere: say so, or it looks like a glitch.
  const [ended] = useState(sessionHasEnded);

  const errors = translateFieldErrors(t, login.error);
  const hasFieldErrors = Object.keys(errors).length > 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.mutate({ email, password, remember });
  }

  return (
    <AuthLayout
      title={t("login.title")}
      description={t("login.description")}
      subtitle={status?.companyName}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {ended && !login.isError ? (
          <p
            role="status"
            className="rounded-lg border border-warning/60 bg-warning/15 px-3 py-2 text-sm"
          >
            {t("login.sessionEnded")}
          </p>
        ) : null}
        {login.isError && !hasFieldErrors ? (
          <ErrorAlert>{translateError(t, login.error)}</ErrorAlert>
        ) : null}

        <FormField id="email" label={t("auth.email")} error={errors.email}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "email-message" : undefined}
          />
        </FormField>

        <FormField id="password" label={t("auth.password")} error={errors.password}>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "password-message" : undefined}
          />
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t("login.remember")}
        </label>

        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("login.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
