import { FilePlus, History, Link2, Pencil, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Markdown } from "@/features/chat/Markdown";
import { translateError } from "@/i18n/errors";
import { ApiRequestError } from "@/lib/api";
import { useDeleteWikiPage, useWikiPage, useWikiRelated } from "@/lib/wiki-queries";
import {
  formatDate,
  formatDateTime,
  StatusBadge,
  TypeBadge,
  useAuthorName,
  useWiki,
  WikiLoader,
} from "./shared";

function isUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export function WikiPageView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug = "" } = useParams();
  const { officeId, base, overview, pageTitles } = useWiki();
  const page = useWikiPage(officeId, slug);
  const remove = useDeleteWikiPage(officeId);
  const related = useWikiRelated(officeId, slug);
  const authorName = useAuthorName();

  if (page.isPending) {
    return <WikiLoader />;
  }
  if (page.isError) {
    const missing = page.error instanceof ApiRequestError && page.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        {missing ? (
          <>
            <p className="font-medium">{t("wiki.pageNotFound")}</p>
            {overview.canEdit ? (
              <Link
                to={`${base}/_new?slug=${encodeURIComponent(slug)}`}
                className={buttonClasses("primary", "sm")}
              >
                <FilePlus aria-hidden />
                {t("wiki.createIt")}
              </Link>
            ) : null}
          </>
        ) : (
          <ErrorAlert>{translateError(t, page.error)}</ErrorAlert>
        )}
      </div>
    );
  }

  const data = page.data;

  return (
    <article className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <header className="space-y-2">
        {data.section ? <p className="text-sm text-muted-foreground">{data.section}</p> : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">{data.title}</h2>
          <div className="flex flex-wrap gap-1">
            <Link to={`${base}/${slug}/history`} className={buttonClasses("ghost", "sm")}>
              <History aria-hidden />
              {t("wiki.history")}
            </Link>
            {overview.canEdit ? (
              <>
                <Link to={`${base}/${slug}/edit`} className={buttonClasses("outline", "sm")}>
                  <Pencil aria-hidden />
                  {t("common.edit")}
                </Link>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={remove.isPending}
                  aria-label={t("common.delete")}
                  title={t("common.delete")}
                  onClick={() => {
                    if (window.confirm(t("wiki.deleteConfirm", { title: data.title }))) {
                      remove.mutate(slug, { onSuccess: () => navigate(base, { replace: true }) });
                    }
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TypeBadge type={data.type} />
          <StatusBadge status={data.status} />
          <span>{t("wiki.revision", { revision: data.revision })}</span>
          <span>·</span>
          <span>
            {t("wiki.updatedBy", {
              name: authorName(data.updatedBy),
              date: formatDateTime(data.updatedAt),
            })}
          </span>
          {data.verifiedOn ? (
            <>
              <span>·</span>
              <span>{t("wiki.verifiedOn", { date: formatDate(data.verifiedOn) })}</span>
            </>
          ) : null}
        </div>
      </header>

      {remove.isError ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}

      {data.content.trim() ? (
        <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
          {data.content}
        </Markdown>
      ) : (
        <p className="text-sm text-muted-foreground">{t("wiki.emptyPage")}</p>
      )}

      {data.sources.length > 0 ? (
        <section aria-labelledby="wiki-sources" className="space-y-1 border-t pt-4">
          <h3 id="wiki-sources" className="text-sm font-semibold">
            {t("wiki.sources")}
          </h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {data.sources.map((source) => (
              <li key={source} className="break-words">
                {isUrl(source) ? (
                  <a href={source} className="text-primary underline underline-offset-2">
                    {source}
                  </a>
                ) : (
                  source
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {related.data && related.data.length > 0 ? (
        <section aria-labelledby="wiki-related" className="space-y-2 border-t pt-4">
          <h3 id="wiki-related" className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4" aria-hidden />
            {t("wiki.related")}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {related.data.map((page) => (
              <li key={page.slug}>
                <Link
                  to={`${base}/${page.slug}`}
                  title={t("wiki.relatedHint", {
                    links: page.signals.links,
                    sources: page.signals.sources,
                    adamicAdar: page.signals.adamicAdar,
                    type: page.signals.type,
                    semantic: page.signals.semantic,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  {page.title}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {page.score.toFixed(1)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.backlinks.length > 0 ? (
        <section aria-labelledby="wiki-backlinks" className="space-y-2 border-t pt-4">
          <h3 id="wiki-backlinks" className="flex items-center gap-1.5 text-sm font-semibold">
            <Link2 className="size-4" aria-hidden />
            {t("wiki.backlinks")}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {data.backlinks.map((link) => (
              <li key={link.slug}>
                <Link
                  to={`${base}/${link.slug}`}
                  className="inline-block rounded-full border px-2.5 py-0.5 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  {link.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
