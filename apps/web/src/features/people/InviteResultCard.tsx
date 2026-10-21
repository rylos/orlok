import type { InvitationResult } from "@orlok/shared";
import { Check, Copy, Eye, MailCheck, MailWarning, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Outcome of an invitation: whether the email left and the link to share otherwise.
export function InviteResultCard({
  result,
  onClose,
}: {
  result: InvitationResult;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const { email } = result;
  // Whoever holds the link can create the account: once the email has left, it is shown only
  // on request.
  const [showLink, setShowLink] = useState(!email.sent);
  const address = result.invitation.email;

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
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
          {email.sent
            ? t("people.inviteSent", { email: address })
            : t("people.inviteNotSent", { email: address })}
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
            <label htmlFor="invite-link" className="sr-only">
              {t("people.inviteLink")}
            </label>
            <Input
              id="invite-link"
              readOnly
              value={result.inviteUrl}
              className="font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button variant="outline" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? t("people.copied") : t("people.copyLink")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("people.inviteLinkHint")}</p>
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
