import type { ActiveSession } from "@orlok/shared";
import { ArrowLeft, Laptop, Loader2, LogOut, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { CommandTypesSection } from "@/features/account/CommandTypesSection";
import { CredentialsSection } from "@/features/account/CredentialsSection";
import { NotificationsSection } from "@/features/account/NotificationsSection";
import { PasswordSection } from "@/features/account/PasswordSection";
import { translateError } from "@/i18n/errors";
import { HeaderActions } from "@/layouts/HeaderActions";
import { useRevokeOtherSessions, useRevokeSession, useSessions } from "@/lib/queries";
import { cn } from "@/lib/utils";

// Browser and operating system from a user agent; good enough to recognize one's own devices.
function describeDevice(userAgent: string | null) {
  if (!userAgent) {
    return null;
  }
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/.test(userAgent)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux|X11/.test(userAgent)
            ? "Linux"
            : null;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(userAgent);
  return { browser, os, mobile };
}

function SessionCard({ session }: { session: ActiveSession }) {
  const { t, i18n } = useTranslation();
  const revoke = useRevokeSession();
  const device = describeDevice(session.userAgent);
  const Icon = device?.mobile ? Smartphone : Laptop;
  const formatTime = (value: string) =>
    new Date(value).toLocaleString(i18n.resolvedLanguage, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const name =
    device?.browser && device.os
      ? t("account.sessions.deviceOn", { browser: device.browser, os: device.os })
      : (device?.browser ?? device?.os ?? t("account.sessions.unknownDevice"));

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{name}</span>
            {session.current ? (
              <Badge variant="success">{t("account.sessions.current")}</Badge>
            ) : null}
            {session.persistent ? <Badge>{t("account.sessions.remembered")}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("account.sessions.lastSeen", { time: formatTime(session.lastSeenAt) })} ·{" "}
            {t("account.sessions.signedIn", { time: formatTime(session.createdAt) })}
          </p>
          {session.userAgent ? (
            <p className="truncate text-xs text-muted-foreground" title={session.userAgent}>
              {session.userAgent}
            </p>
          ) : null}
          {revoke.isError ? <ErrorAlert>{translateError(t, revoke.error)}</ErrorAlert> : null}
        </div>
      </div>
      <Button
        size="sm"
        variant={session.current ? "outline" : "destructive"}
        disabled={revoke.isPending}
        onClick={() => {
          if (!session.current || window.confirm(t("account.sessions.signOutCurrentConfirm"))) {
            revoke.mutate(session);
          }
        }}
      >
        {revoke.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <LogOut aria-hidden />
        )}
        {t("account.sessions.signOut")}
      </Button>
    </Card>
  );
}

// The person's own account: password, notifications, credentials, approved commands and
// signed-in devices (R-AUTH-5, R-OPS-3).
export function AccountPage() {
  const { t } = useTranslation();
  const sessions = useSessions();
  const revokeOthers = useRevokeOtherSessions();
  const others = sessions.data?.filter((session) => !session.current).length ?? 0;

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className={cn(buttonClasses("ghost", "icon"), "md:hidden")}
            aria-label={t("chat.back")}
          >
            <ArrowLeft aria-hidden />
          </Link>
          <h1 className="font-semibold">{t("account.title")}</h1>
        </div>
        <HeaderActions />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <PasswordSection />
          <NotificationsSection />
          <CredentialsSection />
          <CommandTypesSection />
          <section aria-labelledby="account-sessions-title" className="space-y-4">
            <SectionHeader
              id="account-sessions-title"
              title={t("account.sessions.title")}
              description={t("account.sessions.description")}
              action={
                others > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revokeOthers.isPending}
                    onClick={() => {
                      if (window.confirm(t("account.sessions.signOutOthersConfirm"))) {
                        revokeOthers.mutate();
                      }
                    }}
                  >
                    {revokeOthers.isPending ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <LogOut aria-hidden />
                    )}
                    {t("account.sessions.signOutOthers")}
                  </Button>
                ) : null
              }
            />
            {revokeOthers.isError ? (
              <ErrorAlert>{translateError(t, revokeOthers.error)}</ErrorAlert>
            ) : null}
            {sessions.isPending ? (
              <Loader2
                className="size-5 animate-spin text-primary"
                aria-label={t("common.loading")}
              />
            ) : sessions.isError ? (
              <ErrorAlert>{translateError(t, sessions.error)}</ErrorAlert>
            ) : (
              <ul className="grid gap-3">
                {sessions.data.map((session) => (
                  // Without min-w-0 the browser line, which never wraps, widens the card past
                  // the screen on a phone.
                  <li key={session.id} className="min-w-0">
                    <SessionCard session={session} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
