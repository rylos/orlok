import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { translateError } from "@/i18n/errors";
import { useWikiLog } from "@/lib/wiki-queries";
import { LogEntryItem, useWiki, WikiLoader } from "./shared";

// Append-only change log of the office wiki (R-MEM-1).
export function WikiLog() {
  const { t } = useTranslation();
  const { officeId } = useWiki();
  const log = useWikiLog(officeId);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <h2 className="text-2xl font-semibold tracking-tight">{t("wiki.logView.title")}</h2>
      {log.isPending ? (
        <WikiLoader />
      ) : log.isError ? (
        <ErrorAlert>{translateError(t, log.error)}</ErrorAlert>
      ) : log.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("wiki.noChanges")}</p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {log.data.map((entry) => (
            <LogEntryItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
