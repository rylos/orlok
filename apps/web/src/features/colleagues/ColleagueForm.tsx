import { COLLEAGUE_INSTRUCTIONS_MAX, COLLEAGUE_NOTES_MAX, type Colleague } from "@orlok/shared";
import { Bot, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useMyProfiles, useSaveColleague } from "@/lib/colleague-queries";

type ColleagueFormProps = {
  // Where a new colleague is created; an existing one stays in its office.
  officeId: string;
  colleague?: Colleague;
  onSaved: (colleague: Colleague) => void;
  onCancel: () => void;
};

// One of the person's own colleagues, with one of the profiles they are granted (R-ADM-3, R-MOD-2).
export function ColleagueForm({ officeId, colleague, onSaved, onCancel }: ColleagueFormProps) {
  const { t } = useTranslation();
  const save = useSaveColleague();
  const profiles = useMyProfiles();
  const [name, setName] = useState(colleague?.name ?? "");
  const [title, setTitle] = useState(colleague?.title ?? "");
  // A profile no longer granted is not offered again: the person picks one they hold.
  const [profileId, setProfileId] = useState(
    colleague && !colleague.needsProfile ? (colleague.profileId ?? "") : "",
  );
  const [instructions, setInstructions] = useState(colleague?.instructions ?? "");
  const [notes, setNotes] = useState(colleague?.notes ?? "");

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `colleague-${colleague?.id ?? "new"}-${field}`;
  const noProfiles = profiles.isSuccess && profiles.data.length === 0;
  // With a single profile there is nothing to choose; with several the person picks one, since
  // the profile decides what the colleague may do.
  const onlyProfileId = profiles.data?.length === 1 ? profiles.data[0]?.id : undefined;
  useEffect(() => {
    if (onlyProfileId) {
      setProfileId((current) => current || onlyProfileId);
    }
  }, [onlyProfileId]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, title, instructions, profileId };
    if (colleague) {
      save.mutate({ id: colleague.id, input: { ...input, notes } }, { onSuccess: onSaved });
    } else {
      save.mutate({ input: { ...input, officeId } }, { onSuccess: onSaved });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Bot}>
        {colleague ? t("common.editing", { name: colleague.name }) : t("colleagues.new")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}
      {profiles.isError ? <ErrorAlert>{translateError(t, profiles.error)}</ErrorAlert> : null}
      {noProfiles ? <ErrorAlert>{t("colleagues.noProfiles")}</ErrorAlert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("name")} label={t("colleagues.name")} error={errors.name}>
          <Input
            id={id("name")}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(errors.name)}
          />
        </FormField>

        <FormField
          id={id("title")}
          label={t("colleagues.jobTitle")}
          error={errors.title}
          hint={t("colleagues.jobTitleHint")}
        >
          <Input
            id={id("title")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={Boolean(errors.title)}
            aria-describedby={`${id("title")}-message`}
          />
        </FormField>

        <div className="sm:col-span-2">
          <FormField
            id={id("profile")}
            label={t("colleagues.profile")}
            error={errors.profileId}
            hint={t("colleagues.profileHint")}
          >
            <Select
              id={id("profile")}
              required
              value={profileId}
              disabled={!profiles.isSuccess || noProfiles}
              onChange={(event) => setProfileId(event.target.value)}
              aria-invalid={Boolean(errors.profileId)}
              aria-describedby={`${id("profile")}-message`}
            >
              {/* Every colleague works with a profile (R-MOD-2): only a single one is chosen for them. */}
              <option value="" disabled>
                {t("colleagues.chooseProfile")}
              </option>
              {(profiles.data ?? []).map((profile) => {
                // Proposed names already say the mode: it is added only when the name does not.
                const mode = t(`profiles.modes.${profile.mode}.label`);
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.name.toLowerCase().includes(mode.toLowerCase())
                      ? profile.name
                      : `${profile.name} · ${mode}`}
                  </option>
                );
              })}
            </Select>
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <FormField
            id={id("instructions")}
            label={t("colleagues.instructions")}
            error={errors.instructions}
            hint={t("colleagues.instructionsHint")}
          >
            <Textarea
              id={id("instructions")}
              rows={8}
              maxLength={COLLEAGUE_INSTRUCTIONS_MAX}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              aria-invalid={Boolean(errors.instructions)}
              aria-describedby={`${id("instructions")}-message`}
            />
          </FormField>
        </div>

        {/* The colleague's own notes about working with its owner (R-MEM-2). */}
        {colleague ? (
          <div className="sm:col-span-2">
            <FormField
              id={id("notes")}
              label={t("colleagues.notes")}
              error={errors.notes}
              hint={t("colleagues.notesHint")}
            >
              <Textarea
                id={id("notes")}
                rows={6}
                maxLength={COLLEAGUE_NOTES_MAX}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                aria-invalid={Boolean(errors.notes)}
                aria-describedby={`${id("notes")}-message`}
              />
            </FormField>
          </div>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending || noProfiles}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {colleague ? t("colleagues.save") : t("colleagues.create")}
        </Button>
      </div>
    </form>
  );
}
