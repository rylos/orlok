import { WIKI_SYNONYMS_MAX } from "@orlok/shared";
import { CheckCircle2, Loader2, Pencil, Replace } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { translateError } from "@/i18n/errors";
import { useSaveWikiSynonyms } from "@/lib/wiki-queries";
import { useWiki } from "./shared";

// Words that mean the same thing for this office (R-MEM-4): search finds "tunnel" when someone
// asks about "VPN". Shown to the people who manage the wiki.
export function WikiSynonyms() {
  const { t } = useTranslation();
  const { officeId, overview } = useWiki();
  const save = useSaveWikiSynonyms(officeId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const groups = (overview.synonyms ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Replace className="size-4 text-primary" aria-hidden />
          {t("wiki.synonyms.title")}
        </h3>
        {editing ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(overview.synonyms ?? "");
              setSaved(false);
              save.reset();
              setEditing(true);
            }}
          >
            <Pencil aria-hidden />
            {t("wiki.synonyms.edit")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("wiki.synonyms.description")}</p>

      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft.trim() || null, {
              onSuccess: () => {
                setEditing(false);
                setSaved(true);
              },
            });
          }}
        >
          <label htmlFor="wiki-synonyms" className="sr-only">
            {t("wiki.synonyms.title")}
          </label>
          <Textarea
            id="wiki-synonyms"
            rows={5}
            maxLength={WIKI_SYNONYMS_MAX}
            className="font-mono text-sm"
            placeholder={t("wiki.synonyms.placeholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {save.isError ? <ErrorAlert>{translateError(t, save.error)}</ErrorAlert> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("wiki.synonyms.save")}
            </Button>
          </div>
        </form>
      ) : groups.length > 0 ? (
        <ul className="space-y-0.5 font-mono text-sm">
          {groups.map((group) => (
            <li key={group}>{group}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("wiki.synonyms.empty")}</p>
      )}
      {saved && !editing ? (
        <p className="flex items-center gap-1.5 text-xs" aria-live="polite">
          <CheckCircle2 className="size-3.5 text-success" aria-hidden />
          {t("wiki.synonyms.saved")}
        </p>
      ) : null}
    </Card>
  );
}
