import { PASSWORD_MIN_LENGTH } from "@orlok/shared";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { currentLocale } from "@/i18n";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { AuthLayout } from "@/layouts/AuthLayout";
import { useSetup } from "@/lib/queries";

// First-run installation setup (R-ADM-1).
export function SetupPage() {
  const { t } = useTranslation();
  const setup = useSetup();
  const [values, setValues] = useState({
    companyName: "",
    displayName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const errors = translateFieldErrors(t, setup.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const confirmError = passwordMismatch ? t("setup.passwordMismatch") : undefined;

  function update(field: keyof typeof values) {
    return (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  function describedBy(field: string, hasMessage: boolean) {
    return hasMessage ? `${field}-message` : undefined;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mismatch = values.password !== values.confirmPassword;
    setPasswordMismatch(mismatch);
    if (mismatch) {
      return;
    }
    const { confirmPassword: _, ...input } = values;
    // The current language becomes the administrator's and the installation default (R-I18N-3).
    setup.mutate({ ...input, locale: currentLocale() });
  }

  return (
    <AuthLayout title={t("setup.title")} description={t("setup.description")}>
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {setup.isError && !hasFieldErrors ? (
          <ErrorAlert>{translateError(t, setup.error)}</ErrorAlert>
        ) : null}

        <fieldset className="space-y-4">
          <legend className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("setup.company")}
          </legend>
          <FormField id="companyName" label={t("setup.companyName")} error={errors.companyName}>
            <Input
              id="companyName"
              autoComplete="organization"
              required
              value={values.companyName}
              onChange={update("companyName")}
              aria-invalid={Boolean(errors.companyName)}
              aria-describedby={describedBy("companyName", Boolean(errors.companyName))}
            />
          </FormField>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("setup.administrator")}
          </legend>
          <FormField id="displayName" label={t("setup.displayName")} error={errors.displayName}>
            <Input
              id="displayName"
              autoComplete="name"
              required
              value={values.displayName}
              onChange={update("displayName")}
              aria-invalid={Boolean(errors.displayName)}
              aria-describedby={describedBy("displayName", Boolean(errors.displayName))}
            />
          </FormField>

          <FormField id="email" label={t("auth.email")} error={errors.email}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={values.email}
              onChange={update("email")}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={describedBy("email", Boolean(errors.email))}
            />
          </FormField>

          <FormField
            id="password"
            label={t("auth.password")}
            error={errors.password}
            hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          >
            <PasswordInput
              id="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={values.password}
              onChange={update("password")}
              aria-invalid={Boolean(errors.password)}
              aria-describedby="password-message"
            />
          </FormField>

          <FormField id="confirmPassword" label={t("setup.confirmPassword")} error={confirmError}>
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              required
              value={values.confirmPassword}
              onChange={update("confirmPassword")}
              aria-invalid={passwordMismatch}
              aria-describedby={describedBy("confirmPassword", passwordMismatch)}
            />
          </FormField>
        </fieldset>

        <Button type="submit" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
