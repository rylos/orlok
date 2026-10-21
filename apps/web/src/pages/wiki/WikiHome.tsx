import { BookOpen, FilePlus, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useWikiLog } from "@/lib/wiki-queries";
import { LogEntryItem, useWiki, WikiLoader } from "./shared";
import { WikiPurpose } from "./WikiPurpose";
import { WikiSynonyms } from "./WikiSynonyms";

const RECENT_CHANGES = 10;

export function WikiHome() {
  const { t } = useTranslation();
  const { officeId, base, overview } = useWiki();
  const log = useWikiLog(officeId);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("wiki.officeWiki", { office: overview.office.name })}
        </h2>
        <p className="text-muted-foreground">{t("wiki.description")}</p>
      </div>

      <WikiPurpose />
      {overview.canEdit ? <WikiSynonyms /> : null}

      {overview.pages.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <BookOpen className="mx-auto size-8 text-primary" aria-hidden />
          <p className="font-medium">{t("wiki.empty")}</p>
          <p className="text-sm text-muted-foreground">
            {overview.canEdit ? t("wiki.emptyEditor") : t("wiki.emptyReader")}
          </p>
          {overview.canEdit ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Link to={`${base}/_new`} className={buttonClasses("primary", "sm")}>
                <FilePlus aria-hidden />
                {t("wiki.newPage")}
              </Link>
              <Link to={`${base}/_import`} className={buttonClasses("outline", "sm")}>
                <Upload aria-hidden />
                {t("wiki.import")}
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="wiki-recent" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="wiki-recent" className="font-semibold">
            {t("wiki.recentChanges")}
          </h3>
          <Link to={`${base}/_log`} className="text-sm text-primary hover:underline">
            {t("wiki.showLog")}
          </Link>
        </div>
        {log.isPending ? (
          <WikiLoader />
        ) : log.isError ? (
          <ErrorAlert>{translateError(t, log.error)}</ErrorAlert>
        ) : log.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wiki.noChanges")}</p>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {log.data.slice(0, RECENT_CHANGES).map((entry) => (
              <LogEntryItem key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
