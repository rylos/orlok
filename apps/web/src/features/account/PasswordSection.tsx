import { PASSWORD_MIN_LENGTH } from "@orlok/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { PasswordInput } from "@/components/ui/password-input";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { ApiRequestError } from "@/lib/api";
import { useChangePassword } from "@/lib/queries";

// Changing one's own password (R-AUTH-6).
export function PasswordSection() {
  const { t } = useTranslation();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);

  const errors = translateFieldErrors(t, change.error);
  const wrongCurrent = change.error instanceof ApiRequestError && change.error.status === 401;
  const mismatch = confirm.length > 0 && next !== confirm;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mismatch) {
      return;
    }
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setSaved(true);
          setCurrent("");
          setNext("");
          setConfirm("");
        },
      },
    );
  }

  const changed = () => setSaved(false);

  return (
    <section aria-labelledby="account-password-title" className="space-y-4">
      <SectionHeader
        id="account-password-title"
        title={t("account.password.title")}
        description={t("account.password.description")}
      />
      <Card className="p-4">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {change.isError && !wrongCurrent && Object.keys(errors).length === 0 ? (
            <ErrorAlert>{translateError(t, change.error)}</ErrorAlert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FormField
                id="account-current-password"
                label={t("account.password.current")}
                error={wrongCurrent ? t("account.password.wrongCurrent") : undefined}
              >
                <PasswordInput
                  id="account-current-password"
                  required
                  autoComplete="current-password"
                  value={current}
                  aria-invalid={wrongCurrent}
                  onChange={(event) => {
                    setCurrent(event.target.value);
                    changed();
                  }}
                />
              </FormField>
            </div>

            <FormField
              id="account-new-password"
              label={t("account.password.new")}
              error={errors.newPassword}
              hint={t("account.password.hint", { min: PASSWORD_MIN_LENGTH })}
            >
              <PasswordInput
                id="account-new-password"
                required
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                value={next}
                aria-invalid={Boolean(errors.newPassword)}
                onChange={(event) => {
                  setNext(event.target.value);
                  changed();
                }}
              />
            </FormField>

            <FormField
              id="account-confirm-password"
              label={t("account.password.confirm")}
              error={mismatch ? t("account.password.mismatch") : undefined}
            >
              <PasswordInput
                id="account-confirm-password"
                required
                autoComplete="new-password"
                value={confirm}
                aria-invalid={mismatch}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  changed();
                }}
              />
            </FormField>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {saved && !change.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("account.password.saved")}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={change.isPending || mismatch || !current || !next || !confirm}
            >
              {change.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <KeyRound aria-hidden />
              )}
              {t("account.password.save")}
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
