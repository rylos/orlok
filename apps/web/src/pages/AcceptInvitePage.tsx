import { PASSWORD_MIN_LENGTH } from "@orlok/shared";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
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
import { useAcceptInvitation, useInvitationPreview } from "@/lib/invitation-queries";

// Accepting an invitation: the invited person chooses a name and a password (R-ADM-4).
export function AcceptInvitePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation(token);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const suggestedName = preview.data?.displayName;
  useEffect(() => {
    if (suggestedName) {
      setDisplayName((current) => current || suggestedName);
    }
  }, [suggestedName]);

  if (preview.isPending) {
    return <FullPageLoader />;
  }
  if (preview.isError) {
    return (
      <AuthLayout title={t("invite.invalidTitle")} description={t("invite.invalidDescription")}>
        <Link to="/login" className={buttonClasses("outline", "md")}>
          {t("invite.goToLogin")}
        </Link>
      </AuthLayout>
    );
  }

  const { companyName, invitedByName, email } = preview.data;
  const errors = translateFieldErrors(t, accept.error);
  const hasFieldErrors = Object.keys(errors).length > 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mismatch = password !== confirmPassword;
    setPasswordMismatch(mismatch);
    if (!mismatch) {
      accept.mutate(
        { displayName, password },
        { onSuccess: () => navigate("/", { replace: true }) },
      );
    }
  }

  return (
    <AuthLayout
      title={t("invite.title", { company: companyName ?? "Orlok" })}
      description={
        invitedByName
          ? t("invite.description", { inviter: invitedByName })
          : t("invite.descriptionNoInviter")
      }
      subtitle={companyName}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {accept.isError && !hasFieldErrors ? (
          <ErrorAlert>{translateError(t, accept.error)}</ErrorAlert>
        ) : null}

        <FormField id="invite-email" label={t("auth.email")} error={errors.email}>
          <Input id="invite-email" type="email" value={email} readOnly disabled />
        </FormField>

        <FormField id="invite-name" label={t("invite.displayName")} error={errors.displayName}>
          <Input
            id="invite-name"
            autoComplete="name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(errors.displayName)}
          />
        </FormField>

        <FormField
          id="invite-password"
          label={t("auth.password")}
          error={errors.password}
          hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        >
          <PasswordInput
            id="invite-password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors.password)}
            aria-describedby="invite-password-message"
          />
        </FormField>

        <FormField
          id="invite-confirm"
          label={t("setup.confirmPassword")}
          error={passwordMismatch ? t("setup.passwordMismatch") : undefined}
        >
          <PasswordInput
            id="invite-confirm"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={passwordMismatch}
          />
        </FormField>

        <Button type="submit" className="w-full" disabled={accept.isPending}>
          {accept.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("invite.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
