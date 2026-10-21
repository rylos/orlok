import { useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError } from "@/i18n/errors";
import {
  currentPushSubscription,
  PushPermissionError,
  PushServiceError,
  pushSupport,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";
import { queryKeys, useNotificationSettings, useUpdateNotificationSettings } from "@/lib/queries";
import { TelegramLinkCard } from "./TelegramLinkCard";

// Notifications of the current person (R-CHAT-7): email, and push on this device.
export function NotificationsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useNotificationSettings();
  const update = useUpdateNotificationSettings();
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    currentPushSubscription()
      .then((subscription) => setSubscribed(Boolean(subscription)))
      .catch(() => setSubscribed(false));
  }, []);

  async function toggleDevice() {
    if (!settings.data) {
      return;
    }
    setBusy(true);
    setDeviceError(null);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        await subscribeToPush(settings.data.vapidPublicKey);
        setSubscribed(true);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    } catch (error) {
      setDeviceError(
        error instanceof PushPermissionError
          ? t("account.notifications.permissionDenied")
          : error instanceof PushServiceError
            ? t(
                error.brave
                  ? "account.notifications.braveNoPush"
                  : "account.notifications.noPushService",
              )
            : t("account.notifications.failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="account-notifications-title" className="space-y-4">
      <SectionHeader
        id="account-notifications-title"
        title={t("account.notifications.title")}
        description={t("account.notifications.description")}
      />
      {settings.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : settings.isError ? (
        <ErrorAlert>{translateError(t, settings.error)}</ErrorAlert>
      ) : (
        <Card className="space-y-5 p-4">
          <div className="space-y-1">
            <CheckboxField
              label={t("account.notifications.email")}
              checked={settings.data.email}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ email: event.target.checked })}
            />
            <p className="pl-6 text-sm text-muted-foreground">
              {t("account.notifications.emailHint")}
            </p>
          </div>
          <div className="space-y-1">
            <CheckboxField
              label={t("account.notifications.push")}
              checked={settings.data.push}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ push: event.target.checked })}
            />
            <p className="pl-6 text-sm text-muted-foreground">
              {t("account.notifications.pushHint")}
            </p>
          </div>
          {update.isError ? <ErrorAlert>{translateError(t, update.error)}</ErrorAlert> : null}

          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">{t("account.notifications.thisDevice")}</p>
            {support === "insecure" ? (
              <p className="text-sm text-muted-foreground">{t("account.notifications.insecure")}</p>
            ) : support === "unsupported" ? (
              <p className="text-sm text-muted-foreground">
                {t("account.notifications.unsupported")}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant={subscribed ? "outline" : "primary"}
                  disabled={busy || subscribed === null || !settings.data.push}
                  onClick={() => void toggleDevice()}
                >
                  {busy ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : subscribed ? (
                    <BellOff aria-hidden />
                  ) : (
                    <BellRing aria-hidden />
                  )}
                  {subscribed
                    ? t("account.notifications.disable")
                    : t("account.notifications.enable")}
                </Button>
                {subscribed ? (
                  <span className="text-sm text-muted-foreground">
                    {t("account.notifications.enabled")}
                  </span>
                ) : null}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("account.notifications.devices", { count: settings.data.devices })}
            </p>
            {deviceError ? <ErrorAlert>{deviceError}</ErrorAlert> : null}
          </div>
          <TelegramLinkCard />
        </Card>
      )}
    </section>
  );
}
