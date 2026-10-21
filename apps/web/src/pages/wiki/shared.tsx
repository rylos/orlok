import type {
  WikiAuthor,
  WikiLogEntry,
  WikiOverview,
  WikiPageStatus,
  WikiPageType,
} from "@orlok/shared";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router";
import { Badge } from "@/components/ui/badge";
import i18n from "@/i18n";
import { useColleagueRefName } from "@/lib/colleague-queries";

export type WikiContext = {
  officeId: string;
  base: string;
  overview: WikiOverview;
  // Slug → title of every page, for links and existence checks.
  pageTitles: ReadonlyMap<string, string>;
};

// Data loaded once by WikiLayout and shared with the wiki pages.
export function useWiki() {
  return useOutletContext<WikiContext>();
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// A calendar day (YYYY-MM-DD), read as such whatever the time zone.
export function formatDate(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(i18n.resolvedLanguage, {
    dateStyle: "medium",
  });
}

export function useAuthorName() {
  const { t } = useTranslation();
  const colleagueName = useColleagueRefName();
  return (author: WikiAuthor) =>
    author === null
      ? t("wiki.unknownAuthor")
      : author.kind === "colleague"
        ? colleagueName(author)
        : author.name;
}

export function TypeBadge({ type }: { type: WikiPageType }) {
  const { t } = useTranslation();
  return <Badge variant="primary">{t(`wiki.types.${type}`)}</Badge>;
}

// Shown only for pages that no longer describe how things are (R-MEM-13).
export function StatusBadge({ status }: { status: WikiPageStatus }) {
  const { t } = useTranslation();
  return status === "current" ? null : (
    <Badge variant="neutral">{t(`wiki.statuses.${status}`)}</Badge>
  );
}

export function WikiLoader() {
  const { t } = useTranslation();
  return (
    <div className="grid flex-1 place-items-center p-6">
      <Loader2 className="size-6 animate-spin text-primary" aria-label={t("common.loading")} />
    </div>
  );
}

export function LogEntryItem({ entry }: { entry: WikiLogEntry }) {
  const { t } = useTranslation();
  const { base, pageTitles } = useWiki();
  const authorName = useAuthorName();
  const linked = entry.slug !== null && pageTitles.has(entry.slug);

  return (
    <li className="space-y-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{t(`wiki.logView.actions.${entry.action}`)}</Badge>
        {linked ? (
          <Link
            to={`${base}/${entry.slug}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {entry.title}
          </Link>
        ) : (
          <span className="font-medium">{entry.title}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {[authorName(entry.author), formatDateTime(entry.createdAt), entry.detail]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  );
}
