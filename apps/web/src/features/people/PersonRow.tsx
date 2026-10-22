import {
  type AdminOffice,
  isUserRole,
  type ModelProfile,
  type OfficeMembership,
  type PasswordResetResult,
  type Person,
  USER_ROLES,
  type UserRole,
} from "@orlok/shared";
import { KeyRound, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { translateError } from "@/i18n/errors";
import { useResetPassword, useUpdatePerson } from "@/lib/admin-queries";
import { LinkResultCard } from "./LinkResultCard";
import { MembershipsEditor } from "./MembershipsEditor";
import { PersonCommandTypes } from "./PersonCommandTypes";
import { ProfilesPicker } from "./ProfilesPicker";
import { isWithoutOffice } from "./without-office";

type PersonRowProps = {
  person: Person;
  offices: AdminOffice[];
  profiles: ModelProfile[];
  isSelf: boolean;
};

function PersonForm({
  person,
  offices,
  profiles,
  isSelf,
  onDone,
}: PersonRowProps & { onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdatePerson();
  const [role, setRole] = useState<UserRole>(person.role);
  const [disabled, setDisabled] = useState(person.disabled);
  const [memberships, setMemberships] = useState<OfficeMembership[]>(person.memberships);
  const [profileIds, setProfileIds] = useState<string[]>(person.profileIds);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate(
      {
        id: person.id,
        input: { role, disabled, memberships: role === "admin" ? [] : memberships, profileIds },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="font-medium">
        {person.displayName}{" "}
        <span className="font-normal text-muted-foreground">· {person.email}</span>
      </p>
      {update.isError ? <ErrorAlert>{translateError(t, update.error)}</ErrorAlert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`person-${person.id}-role`}
          label={t("people.role")}
          hint={role === "admin" ? t("people.adminHint") : undefined}
        >
          <Select
            id={`person-${person.id}-role`}
            value={role}
            disabled={isSelf}
            onChange={(event) => {
              if (isUserRole(event.target.value)) {
                setRole(event.target.value);
              }
            }}
          >
            {USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex items-end pb-2">
          <CheckboxField
            label={t("people.disable")}
            checked={disabled}
            disabled={isSelf}
            onChange={(event) => setDisabled(event.target.checked)}
          />
        </div>
        {/* An administrator works in every office: there is nothing to choose. */}
        {role === "admin" ? null : (
          <div className="sm:col-span-2">
            <MembershipsEditor
              idPrefix={`person-${person.id}`}
              offices={offices}
              value={memberships}
              onChange={setMemberships}
            />
          </div>
        )}
        <div className="sm:col-span-2">
          <ProfilesPicker profiles={profiles} value={profileIds} onChange={setProfileIds} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("people.save")}
        </Button>
      </div>
    </form>
  );
}

export function PersonRow({ person, offices, profiles, isSelf }: PersonRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetResult, setResetResult] = useState<PasswordResetResult | null>(null);
  const officeName = (id: string) => offices.find((office) => office.id === id)?.name ?? "—";
  const granted = profiles.filter((profile) => person.profileIds.includes(profile.id));

  if (editing) {
    return (
      <PersonForm
        person={person}
        offices={offices}
        profiles={profiles}
        isSelf={isSelf}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{person.displayName}</span>
          {isSelf ? <Badge variant="primary">{t("people.you")}</Badge> : null}
          <Badge>{t(`roles.${person.role}`)}</Badge>
          {person.disabled ? <Badge>{t("people.disabled")}</Badge> : null}
          {isWithoutOffice(person) ? (
            <Badge variant="warning">
              <TriangleAlert className="size-3" aria-hidden />
              {t("people.noOffice")}
            </Badge>
          ) : null}
          {/* Without a profile they cannot create colleagues; the rest still works. */}
          {person.profileIds.length === 0 && !person.disabled ? (
            <Badge variant="info">{t("people.noProfilesBadge")}</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{person.email}</p>
        {isWithoutOffice(person) ? (
          <p className="text-xs text-muted-foreground">{t("people.noOfficeHint")}</p>
        ) : null}
        {person.role === "admin" ? (
          <p className="text-xs text-muted-foreground">{t("people.adminSeesAll")}</p>
        ) : null}
        {person.memberships.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {person.memberships.map((membership) => (
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
        <PersonCommandTypes personId={person.id} />
      </div>
      <div className="flex flex-wrap gap-1">
        {/* A disabled person cannot sign in anyway: enabling them comes first. */}
        {person.disabled ? null : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(true)}>
            <KeyRound aria-hidden />
            {t("people.resetPassword")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          <Pencil aria-hidden />
          {t("common.edit")}
        </Button>
      </div>
      {confirmingReset || resetResult ? (
        <div className="w-full">
          {resetResult ? (
            <LinkResultCard
              key={resetResult.expiresAt}
              id={`person-${person.id}-reset-link`}
              email={resetResult.email}
              title={
                resetResult.email.sent
                  ? t("people.resetSent", { email: person.email })
                  : t("people.resetNotSent", { email: person.email })
              }
              url={resetResult.resetUrl}
              linkLabel={t("people.resetLink")}
              linkHint={
                resetResult.resetUrl ? t("people.resetLinkHint") : t("people.resetSentHint")
              }
              onClose={() => setResetResult(null)}
            />
          ) : (
            <ResetPasswordConfirm
              person={person}
              isSelf={isSelf}
              onCancel={() => setConfirmingReset(false)}
              onDone={(result) => {
                setConfirmingReset(false);
                setResetResult(result);
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

// Resetting ends the person's sessions at once, so it is confirmed first (R-AUTH-7).
function ResetPasswordConfirm({
  person,
  isSelf,
  onCancel,
  onDone,
}: {
  person: Person;
  isSelf: boolean;
  onCancel: () => void;
  onDone: (result: PasswordResetResult) => void;
}) {
  const { t } = useTranslation();
  const reset = useResetPassword();
  return (
    <div className="space-y-3 rounded-lg border border-warning/60 bg-warning/15 p-3 text-sm">
      <p>
        {isSelf
          ? t("people.resetConfirmSelf")
          : t("people.resetConfirm", { name: person.displayName })}
      </p>
      {reset.isError ? <ErrorAlert>{translateError(t, reset.error)}</ErrorAlert> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={reset.isPending}
          onClick={() => reset.mutate(person.id, { onSuccess: onDone })}
        >
          {reset.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("people.resetSend")}
        </Button>
      </div>
    </div>
  );
}
