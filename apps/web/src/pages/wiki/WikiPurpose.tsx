import { CheckCircle2, Loader2, Pencil, Target } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { translateError } from "@/i18n/errors";
import { useSaveWikiPurpose } from "@/lib/wiki-queries";
import { useWiki } from "./shared";

// Purpose of the office wiki: what it is for. Virtual colleagues read it to decide what to keep.
export function WikiPurpose() {
  const { t } = useTranslation();
  const { officeId, overview } = useWiki();
  const save = useSaveWikiPurpose(officeId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Target className="size-4 text-primary" aria-hidden />
          {t("wiki.purpose.title")}
        </h3>
        {overview.canEdit && !editing ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(overview.purpose ?? "");
              setSaved(false);
              save.reset();
              setEditing(true);
            }}
          >
            <Pencil aria-hidden />
            {t("wiki.purpose.edit")}
          </Button>
        ) : null}
      </div>

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
          <label htmlFor="wiki-purpose" className="sr-only">
            {t("wiki.purpose.title")}
          </label>
          <Textarea
            id="wiki-purpose"
            rows={4}
            maxLength={4_000}
            placeholder={t("wiki.purpose.placeholder")}
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
              {t("wiki.purpose.save")}
            </Button>
          </div>
        </form>
      ) : overview.purpose ? (
        <p className="text-sm whitespace-pre-line">{overview.purpose}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {overview.canEdit ? t("wiki.purpose.empty") : t("wiki.purpose.emptyReader")}
        </p>
      )}
      {saved && !editing ? (
        <p className="flex items-center gap-1.5 text-xs" aria-live="polite">
          <CheckCircle2 className="size-3.5 text-success" aria-hidden />
          {t("wiki.purpose.saved")}
        </p>
      ) : null}
    </Card>
  );
}
