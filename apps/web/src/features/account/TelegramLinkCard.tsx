import { ExternalLink, Loader2, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { translateError } from "@/i18n/errors";
import { useNotificationSettings, useUpdateNotificationSettings } from "@/lib/queries";
import { useCreateTelegramLink, useTelegramLink, useUnlinkTelegram } from "@/lib/telegram-queries";

// Linking a Telegram account (R-CHAT-10): a one-time link opens the bot; from then on approvals
// and results arrive there, and the person can talk with their colleagues from Telegram.
export function TelegramLinkCard() {
  const { t } = useTranslation();
  const link = useTelegramLink();
  const create = useCreateTelegramLink();
  const unlink = useUnlinkTelegram();
  const settings = useNotificationSettings();
  const update = useUpdateNotificationSettings();

  if (!link.data?.available) {
    return null;
  }
  const error = create.error ?? unlink.error;
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm font-medium">{t("account.telegram.title")}</p>
      {link.data.linked ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t("account.telegram.linked", {
              username: link.data.username ? `@${link.data.username}` : "",
              bot: `@${link.data.botUsername}`,
            })}
          </p>
          <CheckboxField
            label={t("account.telegram.notify")}
            checked={settings.data?.telegram ?? true}
            disabled={update.isPending || !settings.data}
            onChange={(event) => update.mutate({ telegram: event.target.checked })}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate()}
          >
            <Unlink aria-hidden />
            {t("account.telegram.unlink")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("account.telegram.description")}</p>
          {create.data ? (
            <a
              href={create.data.url}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses("primary", "sm")}
            >
              <ExternalLink aria-hidden />
              {t("account.telegram.open", { bot: `@${link.data.botUsername}` })}
            </a>
          ) : (
            <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("account.telegram.link")}
            </Button>
          )}
          {create.data ? (
            <p className="text-xs text-muted-foreground">{t("account.telegram.linkHint")}</p>
          ) : null}
        </>
      )}
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
    </div>
  );
}
