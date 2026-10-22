import {
  slugify,
  WIKI_LINK_PATTERN,
  WIKI_REVIEW_STATUSES,
  type WikiReviewItem,
  type WikiReviewKind,
  type WikiReviewStatus,
} from "@orlok/shared";
import {
  BookOpenCheck,
  Check,
  FilePlus,
  HeartPulse,
  Lightbulb,
  Loader2,
  MessageSquareText,
  RotateCcw,
  ScanSearch,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Markdown } from "@/features/chat/Markdown";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import {
  useApplyProposal,
  useCheckWiki,
  useLintWiki,
  useUpdateReviewItem,
  useWikiHealth,
  useWikiReview,
} from "@/lib/wiki-queries";
import { useWorkspaceOffices } from "@/lib/workspace-queries";
import { formatDate, formatDateTime, useWiki, WikiLoader } from "./shared";

function PageLinks({ slugs }: { slugs: string[] }) {
  const { base, pageTitles } = useWiki();
  return (
    <>
      {slugs.map((slug, index) => (
        <span key={slug}>
          {index > 0 ? ", " : ""}
          {pageTitles.has(slug) ? (
            <Link
              to={`${base}/${slug}`}
              className="text-primary underline-offset-2 hover:underline"
            >
              {pageTitles.get(slug)}
            </Link>
          ) : (
            slug
          )}
        </span>
      ))}
    </>
  );
}

// The colleague who helps with the review, one of the person's own in the office with a profile
// they still hold, remembered per office in this browser.
function useHelper(officeId: string) {
  const offices = useWorkspaceOffices();
  const colleagues = (
    offices.data?.find((office) => office.id === officeId)?.colleagues ?? []
  ).filter((colleague) => !colleague.needsProfile && !colleague.officeWide);
  const key = `orlok-wiki-helper:${officeId}`;
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  // Until the person picks one, the colleague they talked with most recently in this office.
  const recent = [...colleagues].sort((x, y) =>
    (y.lastTalkedAt ?? "").localeCompare(x.lastTalkedAt ?? ""),
  )[0];
  const helper =
    colleagues.find((colleague) => colleague.id === chosen) ?? recent ?? colleagues[0] ?? null;
  const choose = (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      // Storage unavailable: the choice lasts until the page is left.
    }
  };
  return { colleagues, helper, choose };
}

type Helper = { id: string; name: string } | null;

// Opens a new conversation with the helper, the request already written: the person reads it,
// adds what they want and sends it.
function useAskHelper(helper: Helper) {
  const navigate = useNavigate();
  return (draft: string) => {
    if (helper) {
      navigate(`/colleagues/${helper.id}`, { state: { fresh: true, draft } });
    }
  };
}

function ReviewEntry({ item, helper }: { item: WikiReviewItem; helper: Helper }) {
  const { t } = useTranslation();
  const { officeId, base, overview, pageTitles } = useWiki();
  const update = useUpdateReviewItem(officeId);
  const apply = useApplyProposal(officeId);
  const ask = useAskHelper(helper);
  const page = item.slugs[0];
  const singlePage = SINGLE_PAGE_KINDS.includes(item.kind) && page && pageTitles.has(page);
  const kind = t(`wiki.review.kinds.${item.kind}`);

  // The request as a person would write it: page names instead of link markup, no internal id
  // (the colleague finds the item by its title in the review queue), the pages only when the
  // detail does not already name them.
  function fixPrompt() {
    const titleOf = (slug: string) => pageTitles.get(slug) ?? slug;
    const named = new Set<string>();
    const detail = (item.detail ?? "").replace(WIKI_LINK_PATTERN, (_, target: string, label) => {
      const slug = slugify(target);
      named.add(slug);
      return label?.trim() || titleOf(slug);
    });
    const others = item.slugs.filter((slug) => !named.has(slug));
    const facts = [
      t("wiki.review.fixPrompt.intro", { title: item.title, kind }),
      detail.trim(),
      others.length > 0
        ? t("wiki.review.fixPrompt.pages", { pages: others.map(titleOf).join(", ") })
        : "",
    ].filter(Boolean);
    return `${facts.join("\n")}\n\n${t("wiki.review.fixPrompt.ask")}`;
  }

  return (
    <li className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={URGENT_KINDS.includes(item.kind) ? "primary" : "neutral"}>{kind}</Badge>
        <span className="text-xs text-muted-foreground">
          {[
            item.raisedBy ? t("wiki.review.raisedBy", { name: item.raisedBy }) : null,
            formatDateTime(item.createdAt),
            item.resolvedBy ? t("wiki.review.resolvedBy", { name: item.resolvedBy }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <h3 className="font-medium">
        {singlePage ? (
          <Link to={`${base}/${page}`} className="text-primary underline-offset-2 hover:underline">
            {pageTitles.get(page)}
          </Link>
        ) : (
          item.title
        )}
      </h3>

      <div className="space-y-1 text-sm">
        {item.kind === "isolated_page" ? (
          <p>{t("wiki.review.descriptions.isolated_page")}</p>
        ) : item.kind === "sparse_community" ? (
          <p>
            {t("wiki.review.descriptions.sparse_community")} <PageLinks slugs={item.slugs} />
          </p>
        ) : item.kind === "broken_link" ? (
          <p>
            {t("wiki.review.descriptions.broken_link")} <PageLinks slugs={item.slugs} />
          </p>
        ) : item.kind === "missing_entity" ? (
          <p>
            {t("wiki.review.descriptions.missing_entity", { count: item.slugs.length })}{" "}
            <PageLinks slugs={item.slugs} />
          </p>
        ) : item.kind === "stale_page" ? (
          <p>
            {t("wiki.review.descriptions.stale_page", {
              date: item.detail ? formatDate(item.detail) : "",
            })}
          </p>
        ) : item.kind === "relative_date" ? (
          <>
            <p>{t("wiki.review.descriptions.relative_date")}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {(item.detail ?? "").split("\n").map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : item.kind === "proposal" && item.proposal ? (
          <>
            <p>
              {t(
                item.proposal.action === "create"
                  ? "wiki.review.descriptions.proposalCreate"
                  : "wiki.review.descriptions.proposalUpdate",
                {
                  slug: item.proposal.slug,
                  revision: item.proposal.baseRevision ?? 0,
                  person: item.proposal.proposedFor ?? "?",
                },
              )}
            </p>
            {item.proposal.summary ? (
              <p className="text-muted-foreground">{item.proposal.summary}</p>
            ) : null}
            <details className="rounded-md border bg-muted/30 px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("wiki.review.proposedContent")}
              </summary>
              <div className="mt-2 max-h-96 overflow-auto">
                <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
                  {item.proposal.content}
                </Markdown>
              </div>
            </details>
          </>
        ) : item.kind === "ip_conflict" ? (
          <>
            <p>{t("wiki.review.descriptions.ip_conflict")}</p>
            {item.detail ? (
              <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
                {item.detail
                  .split("\n")
                  .map((line) => `- ${line}`)
                  .join("\n")}
              </Markdown>
            ) : null}
          </>
        ) : (
          <>
            {item.detail ? (
              <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
                {item.detail}
              </Markdown>
            ) : null}
            {item.slugs.length > (singlePage ? 1 : 0) ? (
              <p className="text-muted-foreground">
                {t("wiki.review.pages")}{" "}
                <PageLinks slugs={singlePage ? item.slugs.slice(1) : item.slugs} />
              </p>
            ) : null}
          </>
        )}
      </div>

      {item.status === "open" ? (
        <p className="flex gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {t(`wiki.review.hints.${item.kind}`)}
        </p>
      ) : null}

      {overview.canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {item.status === "open" ? (
            <>
              {helper ? (
                <Button size="sm" variant="outline" onClick={() => ask(fixPrompt())}>
                  <MessageSquareText aria-hidden />
                  {t("wiki.review.fixWith", { name: helper.name })}
                </Button>
              ) : null}
              {item.kind === "proposal" ? (
                <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate(item.id)}>
                  <Check aria-hidden />
                  {t("wiki.review.applyProposal")}
                </Button>
              ) : null}
              {item.suggestedSlug && !pageTitles.has(item.suggestedSlug) ? (
                <Link
                  to={`${base}/_new?slug=${encodeURIComponent(item.suggestedSlug)}`}
                  className={buttonClasses("outline", "sm")}
                >
                  <FilePlus aria-hidden />
                  {t("wiki.review.createPage")}
                </Link>
              ) : null}
              <span className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: item.id, status: "done" })}
                >
                  <Check aria-hidden />
                  {t("wiki.review.markDone")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: item.id, status: "dismissed" })}
                >
                  <X aria-hidden />
                  {t("wiki.review.dismiss")}
                </Button>
              </span>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: item.id, status: "open" })}
            >
              <RotateCcw aria-hidden />
              {t("wiki.review.reopen")}
            </Button>
          )}
        </div>
      ) : null}
      {update.isError ? <ErrorAlert>{translateError(t, update.error)}</ErrorAlert> : null}
      {apply.isError ? <ErrorAlert>{translateError(t, apply.error)}</ErrorAlert> : null}
    </li>
  );
}

// Kinds about a single page, whose title leads the item.
const SINGLE_PAGE_KINDS: WikiReviewKind[] = [
  "isolated_page",
  "stale_page",
  "relative_date",
  "check",
];
// What may be wrong, shown first and highlighted.
const URGENT_KINDS: WikiReviewKind[] = ["contradiction", "check", "ip_conflict", "question"];

function sortByUrgency(items: WikiReviewItem[]) {
  const rank = (item: WikiReviewItem) =>
    URGENT_KINDS.includes(item.kind) ? 0 : SINGLE_PAGE_KINDS.includes(item.kind) ? 2 : 1;
  return [...items].sort((x, y) => rank(x) - rank(y));
}

// The side panel: who helps, and the checks that fill the queue.
function ReviewTools({
  helper,
  colleagues,
  onChoose,
  openCount,
}: {
  helper: Helper;
  colleagues: { id: string; name: string }[];
  onChoose: (id: string) => void;
  openCount: number;
}) {
  const { t } = useTranslation();
  const { officeId, overview } = useWiki();
  const lint = useLintWiki(officeId);
  const check = useCheckWiki(officeId);
  const ask = useAskHelper(helper);

  return (
    <div className="space-y-4">
      {colleagues.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3">
          <label htmlFor="wiki-review-helper" className="shrink-0 text-sm font-medium">
            {t("wiki.review.helper.colleague")}
          </label>
          <Select
            id="wiki-review-helper"
            className="min-w-0 flex-1"
            value={helper?.id ?? ""}
            onChange={(event) => onChoose(event.target.value)}
          >
            {colleagues.map((colleague) => (
              <option key={colleague.id} value={colleague.id}>
                {colleague.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {colleagues.length > 0 ? (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h3 className="flex items-center gap-2 font-medium">
            <MessageSquareText className="size-4 text-primary" aria-hidden />
            {t("wiki.review.helper.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("wiki.review.helper.description")}</p>
          <Button
            className="w-full"
            disabled={!helper || openCount === 0}
            onClick={() => ask(t("wiki.review.guidePrompt"))}
          >
            {t("wiki.review.helper.guide", { name: helper?.name ?? "" })}
          </Button>
        </section>
      ) : null}

      {overview.canEdit ? (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h3 className="flex items-center gap-2 font-medium">
            <ScanSearch className="size-4 text-primary" aria-hidden />
            {t("wiki.review.checks.title")}
          </h3>
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={lint.isPending}
              onClick={() => lint.mutate()}
            >
              {lint.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("wiki.review.lint")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("wiki.review.checks.lint")}</p>
            {lint.isSuccess ? (
              <p className="text-xs" aria-live="polite">
                {t("wiki.review.lintResult", lint.data)}
              </p>
            ) : null}
            {lint.isError ? <ErrorAlert>{translateError(t, lint.error)}</ErrorAlert> : null}
          </div>
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={check.isPending || !helper}
              onClick={() => helper && check.mutate(helper.id)}
            >
              {check.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <BookOpenCheck aria-hidden />
              )}
              {t("wiki.review.check.start", { name: helper?.name ?? "" })}
            </Button>
            <p className="text-xs text-muted-foreground">{t("wiki.review.check.description")}</p>
            {check.isSuccess ? (
              <p className="text-xs" aria-live="polite">
                {t("wiki.review.check.started")}
              </p>
            ) : null}
            {check.isError ? <ErrorAlert>{translateError(t, check.error)}</ErrorAlert> : null}
          </div>
        </section>
      ) : null}

      <WikiHealth />
    </div>
  );
}

const HEALTH_SHOWN = 10;

// Pages with the most problems first, to fix them in batches.
function WikiHealth() {
  const { t } = useTranslation();
  const { officeId } = useWiki();
  const health = useWikiHealth(officeId);
  if (!health.data || health.data.length === 0) {
    return null;
  }
  return (
    <section className="space-y-2 rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <HeartPulse className="size-4 text-primary" aria-hidden />
        {t("wiki.review.health.title", { count: health.data.length })}
      </h3>
      <p className="text-xs text-muted-foreground">{t("wiki.review.health.description")}</p>
      <ul className="divide-y">
        {health.data.slice(0, HEALTH_SHOWN).map((page) => (
          <li key={page.slug} className="space-y-1 py-2 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="w-7 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {page.score}
              </span>
              <span className="min-w-0 flex-1 break-words">
                <PageLinks slugs={[page.slug]} />
              </span>
            </div>
            <p className="pl-9 text-xs text-muted-foreground">
              {page.problems
                .map((problem) => t(`wiki.review.health.problems.${problem}`))
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Review queue: wiki lint findings and questions raised by colleagues,
// each with what to do and a colleague to do it with.
export function WikiReview() {
  const { t } = useTranslation();
  const { officeId } = useWiki();
  const [status, setStatus] = useState<WikiReviewStatus>("open");
  const [kind, setKind] = useState<WikiReviewKind | null>(null);
  const items = useWikiReview(officeId, status);
  const { colleagues, helper, choose } = useHelper(officeId);

  const counts = new Map<WikiReviewKind, number>();
  for (const item of items.data ?? []) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const shown = sortByUrgency((items.data ?? []).filter((item) => !kind || item.kind === kind));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{t("wiki.review.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("wiki.review.description")}</p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex w-fit rounded-md border p-0.5">
              {WIKI_REVIEW_STATUSES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={status === value}
                  onClick={() => {
                    setStatus(value);
                    setKind(null);
                  }}
                  className={cn(
                    "rounded px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring",
                    status === value
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`wiki.review.statuses.${value}`)}
                </button>
              ))}
            </div>
          </div>
          {counts.size > 1 ? (
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="sr-only">{t("wiki.review.filter")}</legend>
              <FilterChip active={kind === null} onClick={() => setKind(null)}>
                {t("wiki.review.all", { count: items.data?.length ?? 0 })}
              </FilterChip>
              {[...counts].map(([value, count]) => (
                <FilterChip key={value} active={kind === value} onClick={() => setKind(value)}>
                  {t(`wiki.review.kinds.${value}`)} · {count}
                </FilterChip>
              ))}
            </fieldset>
          ) : null}

          {items.isPending ? (
            <WikiLoader />
          ) : items.isError ? (
            <ErrorAlert>{translateError(t, items.error)}</ErrorAlert>
          ) : shown.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("wiki.review.empty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {shown.map((item) => (
                <ReviewEntry key={item.id} item={item} helper={helper} />
              ))}
            </ul>
          )}
        </div>

        <aside className="lg:sticky lg:top-4">
          <ReviewTools
            helper={helper}
            colleagues={colleagues}
            onChoose={choose}
            openCount={status === "open" ? (items.data?.length ?? 0) : 1}
          />
        </aside>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-ring",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
