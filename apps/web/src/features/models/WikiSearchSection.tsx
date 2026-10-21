import type { WikiSearchSettings } from "@orlok/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { translateError } from "@/i18n/errors";
import { useProfiles, useSaveWikiSearchSettings, useWikiSearchSettings } from "@/lib/admin-queries";

const COLLEAGUE = "colleague";
const OFF = "off";

function choiceOf(settings: WikiSearchSettings) {
  return settings.queryRewrite ? (settings.queryProfileId ?? COLLEAGUE) : OFF;
}

function settingsOf(choice: string): WikiSearchSettings {
  return choice === OFF
    ? { queryRewrite: false, queryProfileId: null }
    : { queryRewrite: true, queryProfileId: choice === COLLEAGUE ? null : choice };
}

// How colleagues search the wiki before answering (R-MEM-4): a model writes the search from the
// conversation, or the message is searched as written.
export function WikiSearchSection() {
  const { t } = useTranslation();
  const settings = useWikiSearchSettings();
  const profiles = useProfiles();
  const save = useSaveWikiSearchSettings();
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const value = selected ?? (settings.data ? choiceOf(settings.data) : COLLEAGUE);

  return (
    <section aria-labelledby="wiki-search-title" className="space-y-4">
      <SectionHeader
        id="wiki-search-title"
        title={t("models.wikiSearch.title")}
        description={t("models.wikiSearch.description")}
      />
      <Card className="p-4">
        {settings.isPending ? (
          <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
        ) : settings.isError ? (
          <ErrorAlert>{translateError(t, settings.error)}</ErrorAlert>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              save.mutate(settingsOf(value), { onSuccess: () => setSaved(true) });
            }}
          >
            <FormField
              id="wiki-search-model"
              label={t("models.wikiSearch.model")}
              hint={t("models.wikiSearch.modelHint")}
            >
              <Select
                id="wiki-search-model"
                value={value}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setSaved(false);
                }}
              >
                <option value={COLLEAGUE}>{t("models.wikiSearch.colleagueModel")}</option>
                {(profiles.data ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </option>
                ))}
                <option value={OFF}>{t("models.wikiSearch.off")}</option>
              </Select>
            </FormField>
            {save.isError ? <ErrorAlert>{translateError(t, save.error)}</ErrorAlert> : null}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {saved ? (
                <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  {t("models.wikiSearch.saved")}
                </p>
              ) : null}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("models.wikiSearch.save")}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </section>
  );
}
