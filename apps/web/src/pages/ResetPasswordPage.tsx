import { PASSWORD_MIN_LENGTH } from "@orlok/shared";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { FullPageLoader } from "@/components/FullPageState";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { AuthLayout } from "@/layouts/AuthLayout";
import { useCompletePasswordReset, usePasswordResetPreview } from "@/lib/password-reset-queries";

// Choosing a new password from the link an administrator sent (R-AUTH-7).
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const preview = usePasswordResetPreview(token);
  const complete = useCompletePasswordReset(token);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  if (preview.isPending) {
    return <FullPageLoader />;
  }
  if (preview.isError) {
    return (
      <AuthLayout
        title={t("resetPassword.invalidTitle")}
        description={t("resetPassword.invalidDescription")}
      >
        <Link to="/login" className={buttonClasses("outline", "md")}>
          {t("invite.goToLogin")}
        </Link>
      </AuthLayout>
    );
  }

  const { companyName, displayName, email } = preview.data;
  const errors = translateFieldErrors(t, complete.error);
  const hasFieldErrors = Object.keys(errors).length > 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mismatch = password !== confirmPassword;
    setPasswordMismatch(mismatch);
    if (!mismatch) {
      complete.mutate({ password }, { onSuccess: () => navigate("/", { replace: true }) });
    }
  }

  return (
    <AuthLayout
      title={t("resetPassword.title")}
      description={t("resetPassword.description", { name: displayName })}
      subtitle={companyName}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {complete.isError && !hasFieldErrors ? (
          <ErrorAlert>{translateError(t, complete.error)}</ErrorAlert>
        ) : null}

        {/* For the browser's password manager, which saves the new password under this address. */}
        <FormField id="reset-email" label={t("auth.email")}>
          <Input
            id="reset-email"
            type="email"
            autoComplete="username"
            value={email}
            readOnly
            disabled
          />
        </FormField>

        <FormField
          id="reset-password"
          label={t("resetPassword.newPassword")}
          error={errors.password}
          hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        >
          <PasswordInput
            id="reset-password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors.password)}
            aria-describedby="reset-password-message"
          />
        </FormField>

        <FormField
          id="reset-confirm"
          label={t("setup.confirmPassword")}
          error={passwordMismatch ? t("setup.passwordMismatch") : undefined}
        >
          <PasswordInput
            id="reset-confirm"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={passwordMismatch}
          />
        </FormField>

        <Button type="submit" className="w-full" disabled={complete.isPending}>
          {complete.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("resetPassword.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
