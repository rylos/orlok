import type { InvitationResult } from "@orlok/shared";
import { useTranslation } from "react-i18next";
import { LinkResultCard } from "./LinkResultCard";

// Outcome of an invitation: whether the email left and the link to share otherwise.
export function InviteResultCard({
  result,
  onClose,
}: {
  result: InvitationResult;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const address = result.invitation.email;
  return (
    <LinkResultCard
      id="invite-link"
      email={result.email}
      title={
        result.email.sent
          ? t("people.inviteSent", { email: address })
          : t("people.inviteNotSent", { email: address })
      }
      url={result.inviteUrl}
      linkLabel={t("people.inviteLink")}
      linkHint={t("people.inviteLinkHint")}
      onClose={onClose}
    />
  );
}
