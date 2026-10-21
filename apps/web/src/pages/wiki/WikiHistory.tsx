import { ArrowLeft, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Markdown } from "@/features/chat/Markdown";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import {
  useRestoreWikiRevision,
  useWikiPage,
  useWikiRevision,
  useWikiRevisions,
} from "@/lib/wiki-queries";
import { formatDateTime, TypeBadge, useAuthorName, useWiki, WikiLoader } from "./shared";

// Versions of a page, with restore for editors (R-MEM-6).
export function WikiHistory() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { officeId, base, overview, pageTitles } = useWiki();
  const page = useWikiPage(officeId, slug);
  const revisions = useWikiRevisions(officeId, slug);
  const selectedParam = Number(params.get("rev"));
  const selected = Number.isInteger(selectedParam) && selectedParam > 0 ? selectedParam : null;
  const revision = useWikiRevision(officeId, slug, selected);
  const restore = useRestoreWikiRevision(officeId, slug);
  const authorName = useAuthorName();

  if (page.isPending || revisions.isPending) {
    return <WikiLoader />;
  }
  if (page.isError || revisions.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ErrorAlert>{translateError(t, page.error ?? revisions.error)}</ErrorAlert>
      </div>
    );
  }

  const current = page.data.revision;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("wiki.historyView.title", { title: page.data.title })}
        </h2>
        <Link to={`${base}/${slug}`} className={buttonClasses("ghost", "sm")}>
          <ArrowLeft aria-hidden />
          {page.data.title}
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <ul className="divide-y self-start rounded-md border bg-card">
          {revisions.data.map((item) => (
            <li key={item.revision}>
              <button
                type="button"
                onClick={() => setParams({ rev: String(item.revision) })}
                aria-current={selected === item.revision ? "true" : undefined}
                className={cn(
                  "block w-full space-y-0.5 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  selected === item.revision && "bg-accent text-accent-foreground",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {t("wiki.revision", { revision: item.revision })}
                  {item.revision === current ? (
                    <Badge variant="success">{t("wiki.historyView.current")}</Badge>
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {authorName(item.author)} · {formatDateTime(item.createdAt)}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.summary ?? t("wiki.historyView.noSummary")}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-w-0 rounded-md border bg-card p-4">
          {selected === null ? (
            <p className="text-sm text-muted-foreground">{t("wiki.historyView.select")}</p>
          ) : revision.isPending ? (
            <WikiLoader />
          ) : revision.isError ? (
            <ErrorAlert>{translateError(t, revision.error)}</ErrorAlert>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold">{revision.data.title}</h3>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <TypeBadge type={revision.data.type} />
                    {revision.data.section ? <span>{revision.data.section}</span> : null}
                  </div>
                  {/* Provenance (R-MEM-3): what a colleague's change came from. */}
                  {revision.data.origin ? (
                    <p className="text-xs text-muted-foreground">
                      {revision.data.origin.sourceId
                        ? t("wiki.historyView.originDocument")
                        : revision.data.origin.opsJobIds?.length
                          ? t("wiki.historyView.originCommands", {
                              count: revision.data.origin.opsJobIds.length,
                            })
                          : t("wiki.historyView.originConversation")}
                    </p>
                  ) : null}
                </div>
                {overview.canEdit && revision.data.revision !== current ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restore.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("wiki.historyView.restoreConfirm", {
                            revision: revision.data.revision,
                          }),
                        )
                      ) {
                        restore.mutate(revision.data.revision, {
                          onSuccess: (saved) => setParams({ rev: String(saved.revision) }),
                        });
                      }
                    }}
                  >
                    {restore.isPending ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw aria-hidden />
                    )}
                    {t("wiki.historyView.restore")}
                  </Button>
                ) : null}
              </div>
              {restore.isError ? <ErrorAlert>{translateError(t, restore.error)}</ErrorAlert> : null}
              {revision.data.content.trim() ? (
                <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
                  {revision.data.content}
                </Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">{t("wiki.emptyPage")}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
