import type { AdminOffice, Invitation, InvitationResult, ModelProfile } from "@orlok/shared";
import { Ban, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useResendInvitation, useRevokeInvitation } from "@/lib/admin-queries";

type InvitationRowProps = {
  invitation: Invitation;
  offices: AdminOffice[];
  profiles: ModelProfile[];
  onResent: (result: InvitationResult) => void;
};

export function InvitationRow({ invitation, offices, profiles, onResent }: InvitationRowProps) {
  const { t, i18n } = useTranslation();
  const resend = useResendInvitation();
  const revoke = useRevokeInvitation();
  const error = resend.error ?? revoke.error;
  const officeName = (id: string) => offices.find((office) => office.id === id)?.name ?? "—";
  const granted = profiles.filter((profile) => invitation.profileIds.includes(profile.id));
  const expires = new Date(invitation.expiresAt).toLocaleDateString(i18n.resolvedLanguage, {
    dateStyle: "medium",
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{invitation.email}</span>
            {invitation.displayName ? (
              <span className="text-sm text-muted-foreground">{invitation.displayName}</span>
            ) : null}
            <Badge>{t(`roles.${invitation.role}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("people.expires", { date: expires })}
            {invitation.invitedByName
              ? ` · ${t("people.invitedBy", { name: invitation.invitedByName })}`
              : ""}
          </p>
          {invitation.memberships.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {invitation.memberships.map((membership) => (
                <Badge key={membership.officeId}>
                  {officeName(membership.officeId)} · {t(`people.officeRoles.${membership.role}`)}
                </Badge>
              ))}
            </div>
          ) : null}
          {granted.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {granted.map((profile) => (
                <Badge key={profile.id} variant="primary">
                  {profile.name}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={resend.isPending}
            onClick={() => resend.mutate(invitation.id, { onSuccess: onResent })}
          >
            <RefreshCw aria-hidden />
            {t("people.resend")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(t("people.revokeConfirm", { email: invitation.email }))) {
                revoke.mutate(invitation.id);
              }
            }}
          >
            <Ban aria-hidden />
            {t("people.revoke")}
          </Button>
        </div>
      </div>
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
    </div>
  );
}
