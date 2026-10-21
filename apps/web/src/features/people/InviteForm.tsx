import {
  type AdminOffice,
  type InvitationResult,
  isLocale,
  isUserRole,
  LOCALE_NAMES,
  type Locale,
  type ModelProfile,
  type OfficeMembership,
  SUPPORTED_LOCALES,
  USER_ROLES,
  type UserRole,
} from "@orlok/shared";
import { Loader2, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useInvitePerson } from "@/lib/admin-queries";
import { MembershipsEditor } from "./MembershipsEditor";
import { ProfilesPicker } from "./ProfilesPicker";

type InviteFormProps = {
  offices: AdminOffice[];
  profiles: ModelProfile[];
  onCancel: () => void;
  onInvited: (result: InvitationResult) => void;
};

export function InviteForm({ offices, profiles, onCancel, onInvited }: InviteFormProps) {
  const { t } = useTranslation();
  const invite = useInvitePerson();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [locale, setLocale] = useState<Locale | "">("");
  const [memberships, setMemberships] = useState<OfficeMembership[]>([]);
  const [profileIds, setProfileIds] = useState<string[]>([]);

  const errors = translateFieldErrors(t, invite.error);
  const hasFieldErrors = Object.keys(errors).length > 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invite.mutate(
      {
        email,
        displayName: displayName.trim() || null,
        role,
        ...(locale ? { locale } : {}),
        memberships: role === "admin" ? [] : memberships,
        profileIds,
      },
      { onSuccess: onInvited },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {invite.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, invite.error)}</ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="invite-email" label={t("people.email")} error={errors.email}>
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(errors.email)}
          />
        </FormField>

        <FormField
          id="invite-name"
          label={t("people.displayName")}
          error={errors.displayName}
          hint={t("people.displayNameHint")}
        >
          <Input
            id="invite-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-describedby="invite-name-message"
          />
        </FormField>

        <FormField
          id="invite-role"
          label={t("people.role")}
          hint={role === "admin" ? t("people.adminHint") : undefined}
        >
          <Select
            id="invite-role"
            value={role}
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

        <FormField id="invite-locale" label={t("people.language")} hint={t("people.languageHint")}>
          <Select
            id="invite-locale"
            value={locale}
            onChange={(event) => setLocale(isLocale(event.target.value) ? event.target.value : "")}
            aria-describedby="invite-locale-message"
          >
            <option value="">{t("people.defaultLanguage")}</option>
            {SUPPORTED_LOCALES.map((value) => (
              <option key={value} value={value}>
                {LOCALE_NAMES[value]}
              </option>
            ))}
          </Select>
        </FormField>

        {/* An administrator works in every office: there is nothing to choose. */}
        {role === "admin" ? null : (
          <div className="sm:col-span-2">
            <MembershipsEditor
              idPrefix="invite"
              offices={offices}
              value={memberships}
              onChange={setMemberships}
            />
            {errors.memberships ? (
              <p className="mt-1 text-sm text-destructive">{errors.memberships}</p>
            ) : null}
          </div>
        )}
        <div className="sm:col-span-2">
          <ProfilesPicker profiles={profiles} value={profileIds} onChange={setProfileIds} />
          {errors.profileIds ? (
            <p className="mt-1 text-sm text-destructive">{errors.profileIds}</p>
          ) : null}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Send aria-hidden />
          )}
          {t("people.send")}
        </Button>
      </div>
    </form>
  );
}
