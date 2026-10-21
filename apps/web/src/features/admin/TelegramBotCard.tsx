import { CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { PasswordInput } from "@/components/ui/password-input";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useRemoveTelegramBot, useSaveTelegramBot, useTelegramBot } from "@/lib/telegram-queries";

// The installation's Telegram bot (R-CHAT-10): a token from @BotFather. Orlok asks Telegram for
// messages, so nothing has to be reachable from the internet.
export function TelegramBotCard() {
  const { t } = useTranslation();
  const bot = useTelegramBot();
  const save = useSaveTelegramBot();
  const remove = useRemoveTelegramBot();
  const [token, setToken] = useState("");
  const errors = translateFieldErrors(t, save.error);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(token.trim(), { onSuccess: () => setToken("") });
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{t("telegram.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("telegram.description")}</p>
      </div>
      {bot.data?.configured ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("telegram.configured", { bot: `@${bot.data.botUsername}` })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("telegram.removeConfirm"))) {
                remove.mutate();
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("telegram.remove")}
          </Button>
        </div>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <FormField
            id="telegram-token"
            label={bot.data?.configured ? t("telegram.replaceToken") : t("telegram.token")}
            error={errors.token}
            hint={t("telegram.tokenHint")}
          >
            <PasswordInput
              id="telegram-token"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-invalid={Boolean(errors.token)}
              aria-describedby="telegram-token-message"
            />
          </FormField>
        </div>
        <Button type="submit" disabled={save.isPending || !token.trim()}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("telegram.save")}
        </Button>
      </form>
      {save.isError && Object.keys(errors).length === 0 ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}
      {remove.isError ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}
    </Card>
  );
}
