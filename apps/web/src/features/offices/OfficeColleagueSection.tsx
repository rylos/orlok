import { type AdminOffice, COLLEAGUE_INSTRUCTIONS_MAX, type Colleague } from "@orlok/shared";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useDeleteOfficeColleague, useProfiles, useSaveOfficeColleague } from "@/lib/admin-queries";

function OfficeColleagueForm({
  office,
  colleague,
  onDone,
}: {
  office: AdminOffice;
  colleague: Colleague | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveOfficeColleague();
  const profiles = useProfiles();
  const [name, setName] = useState(colleague?.name ?? t("offices.colleague.defaultName"));
  const [title, setTitle] = useState(colleague?.title ?? "");
  // A deleted profile is not offered again: the administrator picks another one.
  const [profileId, setProfileId] = useState(colleague?.profileId ?? "");
  const [instructions, setInstructions] = useState(colleague?.instructions ?? "");

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `office-colleague-${office.id}-${field}`;
  const noProfiles = profiles.isSuccess && profiles.data.length === 0;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, title, instructions, profileId };
    save.mutate(
      colleague ? { officeId: office.id, input } : { officeId: office.id, create: true, input },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={UsersRound}>
        {colleague ? t("common.editing", { name: colleague.name }) : t("offices.colleague.create")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}
      {profiles.isError ? <ErrorAlert>{translateError(t, profiles.error)}</ErrorAlert> : null}
      {noProfiles ? <ErrorAlert>{t("offices.needProfile")}</ErrorAlert> : null}

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
          hint={t("offices.colleague.titleHint")}
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
            hint={t("offices.colleague.profileHint")}
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
              <option value="" disabled>
                {t("colleagues.chooseProfile")}
              </option>
              {/* Every profile: the mode does not matter, it only reads the wiki (R-ADM-8). */}
              {(profiles.data ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <FormField
            id={id("instructions")}
            label={t("colleagues.instructions")}
            error={errors.instructions}
            hint={t("offices.colleague.instructionsHint")}
          >
            <Textarea
              id={id("instructions")}
              rows={6}
              maxLength={COLLEAGUE_INSTRUCTIONS_MAX}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              aria-invalid={Boolean(errors.instructions)}
              aria-describedby={`${id("instructions")}-message`}
            />
          </FormField>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
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

// The colleague of the whole office (R-ADM-8): set up here by administrators, found by everyone in
// the office in their own list, each in private conversations, and only reading the wiki.
export function OfficeColleagueSection({ office }: { office: AdminOffice }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const save = useSaveOfficeColleague();
  const remove = useDeleteOfficeColleague();
  const { colleague } = office;
  const archived = colleague?.archivedAt != null;
  const error = save.error ?? remove.error;

  if (editing) {
    return (
      <div className="border-t pt-4">
        <OfficeColleagueForm
          office={office}
          colleague={colleague}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <UsersRound className="size-4 text-primary" aria-hidden />
          {t("offices.colleague.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("offices.colleague.description")}</p>
      </div>
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
      {colleague ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{colleague.name}</p>
            {colleague.title ? (
              <p className="truncate text-sm text-muted-foreground">{colleague.title}</p>
            ) : null}
            {colleague.needsProfile ? (
              <p role="status" className="mt-1 flex items-start gap-1.5 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("offices.colleague.needsProfile")}
              </p>
            ) : null}
            {archived ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t("offices.colleague.archived")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {t("common.edit")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate({ officeId: office.id, input: { archived: !archived } })}
            >
              {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              {archived ? t("colleagues.keep.restore") : t("colleagues.keep.archive")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(t("offices.colleague.deleteConfirm", { name: colleague.name }))
                ) {
                  remove.mutate(office.id);
                }
              }}
            >
              <Trash2 aria-hidden />
              {t("common.delete")}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Plus aria-hidden />
          {t("offices.colleague.create")}
        </Button>
      )}
    </div>
  );
}
