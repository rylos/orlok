import type { InvitationResult } from "@orlok/shared";
import { Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InvitationRow } from "@/features/people/InvitationRow";
import { InviteForm } from "@/features/people/InviteForm";
import { InviteResultCard } from "@/features/people/InviteResultCard";
import { PersonRow } from "@/features/people/PersonRow";
import { translateError } from "@/i18n/errors";
import { useAdminOffices, usePeople, useProfiles } from "@/lib/admin-queries";
import { useMe } from "@/lib/queries";

// People, invitations, office memberships and granted profiles (R-ADM-4, R-MOD-2).
export function PeoplePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const overview = usePeople();
  const offices = useAdminOffices();
  const [inviting, setInviting] = useState(false);
  const [lastResult, setLastResult] = useState<InvitationResult | null>(null);
  const officeList = offices.data ?? [];
  const profiles = useProfiles();
  const profileList = profiles.data ?? [];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("people.title")}</h1>
          <p className="text-muted-foreground">{t("people.description")}</p>
        </div>
        {inviting ? null : (
          <Button
            size="sm"
            onClick={() => {
              setInviting(true);
              setLastResult(null);
            }}
          >
            <UserPlus aria-hidden />
            {t("people.invite")}
          </Button>
        )}
      </div>

      {lastResult ? (
        <InviteResultCard
          key={lastResult.inviteUrl}
          result={lastResult}
          onClose={() => setLastResult(null)}
        />
      ) : null}

      {inviting ? (
        <Card className="p-4">
          <InviteForm
            offices={officeList}
            profiles={profileList}
            onCancel={() => setInviting(false)}
            onInvited={(result) => {
              setInviting(false);
              setLastResult(result);
            }}
          />
        </Card>
      ) : null}

      {overview.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : overview.isError ? (
        <ErrorAlert>{translateError(t, overview.error)}</ErrorAlert>
      ) : (
        <>
          <section aria-labelledby="people-title" className="space-y-3">
            <h2 id="people-title" className="text-lg font-semibold tracking-tight">
              {t("people.peopleTitle")}
            </h2>
            <ul className="divide-y rounded-xl border bg-card">
              {overview.data.people.map((person) => (
                <li key={person.id} className="p-4">
                  <PersonRow
                    person={person}
                    offices={officeList}
                    profiles={profileList}
                    isSelf={person.id === me?.id}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="invitations-title" className="space-y-3">
            <h2 id="invitations-title" className="text-lg font-semibold tracking-tight">
              {t("people.invitationsTitle")}
            </h2>
            {overview.data.invitations.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("people.noInvitations")}
              </p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card">
                {overview.data.invitations.map((invitation) => (
                  <li key={invitation.id} className="p-4">
                    <InvitationRow
                      invitation={invitation}
                      offices={officeList}
                      profiles={profileList}
                      onResent={setLastResult}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
