import type { WikiPageSummary } from "@orlok/shared";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  FilePlus,
  History,
  ListChecks,
  Network,
  Search,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useMatch, useParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translateError } from "@/i18n/errors";
import { HeaderActions } from "@/layouts/HeaderActions";
import { cn } from "@/lib/utils";
import { useWikiOverview, useWikiSearch } from "@/lib/wiki-queries";
import { type WikiContext, WikiLoader } from "./shared";

const SEARCH_DELAY_MS = 250;
const GENERAL_KEY = "";

function pageLinkClasses({ isActive }: { isActive: boolean }) {
  return cn(
    "block rounded-md px-2 py-1.5 text-sm",
    "hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
    isActive && "bg-accent text-accent-foreground",
  );
}

// Sections such as "Servers / Linux" form a tree; pages without a section go to "General".
type SectionNode = {
  key: string;
  name: string;
  pages: WikiPageSummary[];
  children: SectionNode[];
  total: number;
};

function sectionParts(section: string | null) {
  return (section ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildSectionTree(pages: WikiPageSummary[], generalName: string) {
  const general: SectionNode = {
    key: GENERAL_KEY,
    name: generalName,
    pages: [],
    children: [],
    total: 0,
  };
  const roots: SectionNode[] = [];
  for (const page of pages) {
    const parts = sectionParts(page.section);
    if (parts.length === 0) {
      general.pages.push(page);
      general.total++;
      continue;
    }
    let level = roots;
    let node: SectionNode | undefined;
    parts.forEach((name, index) => {
      const key = parts.slice(0, index + 1).join(" / ");
      node = level.find((item) => item.key === key);
      if (!node) {
        node = { key, name, pages: [], children: [], total: 0 };
        level.push(node);
      }
      node.total++;
      level = node.children;
    });
    node?.pages.push(page);
  }
  return general.total > 0 ? [general, ...roots] : roots;
}

// Keys of a section and of the sections containing it.
function ancestorKeys(section: string | null) {
  const parts = sectionParts(section);
  return parts.length === 0
    ? [GENERAL_KEY]
    : parts.map((_, index) => parts.slice(0, index + 1).join(" / "));
}

function storageKey(officeId: string) {
  return `orlok-wiki-sections:${officeId}`;
}

// Open sections are remembered per office in this browser; everything starts collapsed.
function loadExpanded(officeId: string) {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(officeId)) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

type SectionTreeProps = {
  nodes: SectionNode[];
  base: string;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
};

function SectionTree({ nodes, base, expanded, onToggle }: SectionTreeProps) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        const open = expanded.has(node.key);
        return (
          <li key={node.key}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(node.key)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase",
                "hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
              )}
            >
              <ChevronRight
                className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="font-normal tabular-nums">{node.total}</span>
            </button>
            {open ? (
              <div className="ml-3 space-y-0.5 border-l pl-2">
                {node.pages.length > 0 ? (
                  <ul className="space-y-0.5">
                    {node.pages.map((page) => (
                      <li key={page.slug}>
                        <NavLink to={`${base}/${page.slug}`} className={pageLinkClasses}>
                          <span
                            className={cn(
                              "block truncate",
                              page.status !== "current" && "text-muted-foreground italic",
                            )}
                          >
                            {page.title}
                          </span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {node.children.length > 0 ? (
                  <SectionTree
                    nodes={node.children}
                    base={base}
                    expanded={expanded}
                    onToggle={onToggle}
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// Office wiki (R-MEM-9): page list and search on the left, the selected view on the right.
// On small screens the list is shown on the wiki home and the page everywhere else.
export function WikiLayout() {
  const { t } = useTranslation();
  const { officeId = "" } = useParams();
  const overview = useWikiOverview(officeId);
  const atHome = useMatch("/offices/:officeId/wiki") !== null;
  const activeSlug = useMatch("/offices/:officeId/wiki/:slug/*")?.params.slug;
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const search = useWikiSearch(officeId, searchText);
  const [expanded, setExpanded] = useState(() => loadExpanded(officeId));

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  function saveExpanded(next: Set<string>) {
    setExpanded(next);
    try {
      localStorage.setItem(storageKey(officeId), JSON.stringify([...next]));
    } catch {
      // Storage unavailable: the state lasts for this visit only.
    }
  }

  function toggleSection(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    saveExpanded(next);
  }

  const pages = overview.data?.pages;
  const activeSection = pages?.find((page) => page.slug === activeSlug)?.section;

  // The section of the open page is expanded so the page is visible in the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the open page changes
  useEffect(() => {
    if (activeSection === undefined) {
      return;
    }
    const missing = ancestorKeys(activeSection).filter((key) => !expanded.has(key));
    if (missing.length > 0) {
      saveExpanded(new Set([...expanded, ...missing]));
    }
  }, [activeSlug, activeSection]);

  const base = `/offices/${officeId}/wiki`;
  const context = useMemo<WikiContext | null>(
    () =>
      overview.data
        ? {
            officeId,
            base,
            overview: overview.data,
            pageTitles: new Map(overview.data.pages.map((page) => [page.slug, page.title])),
          }
        : null,
    [officeId, base, overview.data],
  );
  const tree = useMemo(() => buildSectionTree(pages ?? [], t("wiki.noSection")), [pages, t]);

  if (overview.isPending) {
    return <WikiLoader />;
  }
  if (overview.isError || !context) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-sm space-y-4 text-center">
          <ErrorAlert>{translateError(t, overview.error)}</ErrorAlert>
          <Link to="/" className={buttonClasses("outline", "sm")}>
            <ArrowLeft aria-hidden />
            {t("chat.back")}
          </Link>
        </div>
      </div>
    );
  }

  const { canEdit, office } = context.overview;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={atHome ? "/" : base}
            className={cn(buttonClasses("ghost", "icon"), "md:hidden")}
            aria-label={atHome ? t("chat.back") : t("wiki.back")}
          >
            <ArrowLeft aria-hidden />
          </Link>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <BookOpen className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">
              <Link to={base} className="hover:underline">
                {t("wiki.title")}
              </Link>
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              {office.name} · {t("wiki.pages", { count: context.overview.pages.length })}
            </p>
          </div>
        </div>
        <HeaderActions />
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          className={cn(
            "min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 md:w-72 md:flex-none md:border-r",
            atHome ? "flex" : "hidden md:flex",
          )}
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="wiki-search" className="sr-only">
              {t("wiki.search")}
            </label>
            <Input
              id="wiki-search"
              type="search"
              className="pl-9"
              placeholder={t("wiki.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {canEdit ? (
              <>
                <Link to={`${base}/_new`} className={buttonClasses("outline", "sm")}>
                  <FilePlus aria-hidden />
                  {t("wiki.newPage")}
                </Link>
                <Link to={`${base}/_import`} className={buttonClasses("ghost", "sm")}>
                  <Upload aria-hidden />
                  {t("wiki.import")}
                </Link>
              </>
            ) : null}
            <Link to={`${base}/_graph`} className={buttonClasses("ghost", "sm")}>
              <Network aria-hidden />
              {t("wiki.graphLink")}
            </Link>
            <Link to={`${base}/_review`} className={buttonClasses("ghost", "sm")}>
              <ListChecks aria-hidden />
              {t("wiki.reviewLink")}
              {context.overview.openReviews > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                  {context.overview.openReviews}
                </span>
              ) : null}
            </Link>
            <Link to={`${base}/_log`} className={buttonClasses("ghost", "sm")}>
              <History aria-hidden />
              {t("wiki.log")}
            </Link>
          </div>

          <nav aria-label={t("wiki.title")}>
            {searchText ? (
              search.isError ? (
                <ErrorAlert>{translateError(t, search.error)}</ErrorAlert>
              ) : search.data?.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">{t("wiki.noResults")}</p>
              ) : (
                <ul className="space-y-1">
                  {(search.data ?? []).map((result) => (
                    <li key={result.slug}>
                      <NavLink to={`${base}/${result.slug}`} className={pageLinkClasses}>
                        <span className="block font-medium">{result.title}</span>
                        {result.status !== "current" ? (
                          <span className="block text-xs text-muted-foreground italic">
                            {t(`wiki.statuses.${result.status}`)}
                          </span>
                        ) : null}
                        {result.section ? (
                          <span className="block text-xs text-muted-foreground">
                            {result.section}
                          </span>
                        ) : null}
                        {result.snippet ? (
                          <span className="mt-0.5 line-clamp-3 block text-xs text-muted-foreground">
                            {result.snippet}
                          </span>
                        ) : null}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <SectionTree nodes={tree} base={base} expanded={expanded} onToggle={toggleSection} />
            )}
          </nav>
        </aside>

        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
            atHome ? "hidden md:flex" : "flex",
          )}
        >
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
