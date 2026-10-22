import type { InvitationEmailStatus } from "@orlok/shared";
import { Check, Copy, Eye, MailCheck, MailWarning, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Outcome of an email carrying a link (invitation, password reset): whether the email left and
// the link to share otherwise.
export function LinkResultCard({
  id,
  email,
  title,
  url,
  linkLabel,
  linkHint,
  onClose,
}: {
  id: string;
  email: InvitationEmailStatus;
  title: string;
  url: string;
  linkLabel: string;
  linkHint: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Whoever holds the link gets into the account: once the email has left, it is shown only on
  // request.
  const [showLink, setShowLink] = useState(!email.sent);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card
      className={cn("space-y-3 p-4", email.sent ? "border-success/50" : "border-warning/60")}
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 font-medium">
          {email.sent ? (
            <MailCheck className="size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <MailWarning className="size-4 shrink-0 text-warning" aria-hidden />
          )}
          {title}
        </p>
        <Button size="icon" variant="ghost" aria-label={t("common.close")} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>

      {email.sent ? null : (
        <p className="text-sm text-muted-foreground">
          {email.reason === "not_configured"
            ? t("people.emailNotConfigured")
            : t("people.emailFailed", { message: email.message ?? "" })}
        </p>
      )}

      {showLink ? (
        <>
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <label htmlFor={id} className="sr-only">
              {linkLabel}
            </label>
            <Input
              id={id}
              readOnly
              value={url}
              className="font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button variant="outline" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? t("people.copied") : t("people.copyLink")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{linkHint}</p>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setShowLink(true)}>
          <Eye aria-hidden />
          {t("people.showLink")}
        </Button>
      )}
    </Card>
  );
}
