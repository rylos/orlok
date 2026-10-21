import {
  WIKI_LINT_KINDS,
  WIKI_MODEL_REVIEW_KINDS,
  type WikiHealthProblem,
  type WikiLintResult,
  type WikiPageHealth,
  type WikiProposal,
  type WikiReviewItem,
  type WikiReviewKind,
  type WikiReviewStatus,
} from "@orlok/shared";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  colleagues,
  offices,
  settings,
  users,
  wikiLinks,
  wikiPages,
  wikiReviewItems,
} from "../db/schema";
import { appendLog, type DbExecutor, findPageRow, insertPage, savePageRevision } from "./wiki";
import { getWikiGraph } from "./wiki-graph";
import {
  addressConflicts,
  hostsWithoutPage,
  isStaleVerification,
  relativeDateLines,
} from "./wiki-lint";

type ReviewInput = {
  kind: WikiReviewKind;
  // Lint findings have a stable key; items raised by colleagues do not.
  key: string | null;
  title: string;
  detail?: string | null;
  slugs?: string[];
  suggestedSlug?: string | null;
  colleagueId?: string | null;
};

function isModelKind(kind: WikiReviewKind) {
  return (WIKI_MODEL_REVIEW_KINDS as readonly string[]).includes(kind);
}

export async function listReviewItems(
  db: Db,
  officeId: string,
  status?: WikiReviewStatus,
): Promise<WikiReviewItem[]> {
  const rows = await db
    .select({
      item: wikiReviewItems,
      raisedBy: colleagues.name,
      resolvedBy: users.displayName,
    })
    .from(wikiReviewItems)
    .leftJoin(colleagues, eq(wikiReviewItems.raisedByColleagueId, colleagues.id))
    .leftJoin(users, eq(wikiReviewItems.resolvedByUserId, users.id))
    .where(
      and(
        eq(wikiReviewItems.officeId, officeId),
        status ? eq(wikiReviewItems.status, status) : undefined,
      ),
    )
    .orderBy(desc(wikiReviewItems.createdAt))
    .limit(300);
  return rows.map(({ item, raisedBy, resolvedBy }) => ({
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    detail: item.detail,
    slugs: item.slugs,
    suggestedSlug: item.suggestedSlug,
    raisedBy,
    resolvedBy,
    proposal: item.proposal,
    createdAt: item.createdAt.toISOString(),
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
  }));
}

export async function countOpenReviewItems(db: Db, officeId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(wikiReviewItems)
    .where(and(eq(wikiReviewItems.officeId, officeId), eq(wikiReviewItems.status, "open")));
  return row?.value ?? 0;
}

// Opens an item, or refreshes the open one with the same key or title. Returns true when a new
// item was opened (or a finding that had been fixed came back).
export async function raiseReviewItem(db: DbExecutor, officeId: string, input: ReviewInput) {
  const values = {
    title: input.title.slice(0, 300),
    detail: input.detail?.slice(0, 4_000) ?? null,
    slugs: (input.slugs ?? []).slice(0, 50),
    suggestedSlug: input.suggestedSlug ?? null,
  };
  const [existing] = await db
    .select({ id: wikiReviewItems.id, status: wikiReviewItems.status })
    .from(wikiReviewItems)
    .where(
      and(
        eq(wikiReviewItems.officeId, officeId),
        input.key
          ? eq(wikiReviewItems.key, input.key)
          : and(
              eq(wikiReviewItems.status, "open"),
              eq(wikiReviewItems.kind, input.kind),
              sql`lower(${wikiReviewItems.title}) = lower(${values.title})`,
            ),
      ),
    )
    .limit(1);
  // What people dismissed never comes back; what a model raised and people closed does not
  // either, since a model saying it again is no news.
  if (
    existing?.status === "dismissed" ||
    (existing?.status === "done" && isModelKind(input.kind))
  ) {
    return false;
  }
  if (existing) {
    await db
      .update(wikiReviewItems)
      .set({ ...values, status: "open", resolvedAt: null, resolvedByUserId: null })
      .where(eq(wikiReviewItems.id, existing.id));
    return existing.status !== "open";
  }
  await db.insert(wikiReviewItems).values({
    officeId,
    kind: input.kind,
    key: input.key,
    raisedByColleagueId: input.colleagueId ?? null,
    ...values,
  });
  return true;
}

export async function updateReviewItem(
  db: Db,
  officeId: string,
  id: string,
  status: WikiReviewStatus,
  userId: string,
) {
  const [row] = await db
    .update(wikiReviewItems)
    .set(
      status === "open"
        ? { status, resolvedAt: null, resolvedByUserId: null }
        : { status, resolvedAt: new Date(), resolvedByUserId: userId },
    )
    .where(and(eq(wikiReviewItems.id, id), eq(wikiReviewItems.officeId, officeId)))
    .returning({ id: wikiReviewItems.id });
  return row
    ? ((await listReviewItems(db, officeId)).find((item) => item.id === id) ?? null)
    : null;
}

// Structural lint (R-MEM-7): isolated pages, sparse communities and links to missing pages.
export async function lintWiki(db: Db, officeId: string): Promise<WikiLintResult> {
  const graph = await getWikiGraph(db, officeId);
  const nodes = new Map(graph.nodes.map((node) => [node.slug, node]));
  const findings: ReviewInput[] = [];

  for (const slug of graph.insights.isolated) {
    const node = nodes.get(slug);
    // Overviews and short notes may legitimately stand alone.
    if (node && node.type !== "overview") {
      findings.push({
        kind: "isolated_page",
        key: `isolated:${slug}`,
        title: node.title,
        slugs: [slug],
      });
    }
  }

  for (const id of graph.insights.sparseCommunities) {
    const members = graph.nodes
      .filter((node) => node.community === id)
      .sort((x, y) => y.degree - x.degree);
    const hub = members[0];
    if (hub) {
      findings.push({
        kind: "sparse_community",
        key: `sparse:${hub.slug}`,
        title: graph.communities.find((community) => community.id === id)?.label ?? hub.title,
        slugs: members.map((node) => node.slug),
      });
    }
  }

  const broken = await db
    .select({
      target: wikiLinks.targetSlug,
      from: sql<string[]>`array_agg(distinct ${wikiPages.slug})`,
    })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
    .where(
      and(
        eq(wikiPages.officeId, officeId),
        sql`not exists (select 1 from ${wikiPages} target where target.office_id = ${officeId} and target.slug = ${wikiLinks.targetSlug})`,
      ),
    )
    .groupBy(wikiLinks.targetSlug);
  for (const { target, from } of broken) {
    findings.push({
      kind: "broken_link",
      key: `broken:${target}`,
      title: target,
      slugs: from,
      suggestedSlug: target,
    });
  }

  const pages = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      content: wikiPages.content,
      status: wikiPages.status,
      verifiedOn: wikiPages.verifiedOn,
    })
    .from(wikiPages)
    .where(eq(wikiPages.officeId, officeId));
  // Outdated pages keep old values on purpose.
  const current = pages.filter((page) => page.status === "current");

  for (const conflict of addressConflicts(current)) {
    findings.push({
      kind: "ip_conflict",
      key: `ip:${conflict.host}`,
      title: conflict.host,
      detail: conflict.addresses
        .map(({ ip, slugs }) => `${ip}: ${slugs.map((slug) => `[[${slug}]]`).join(", ")}`)
        .join("\n"),
      slugs: [...new Set(conflict.addresses.flatMap(({ slugs }) => slugs))],
    });
  }

  for (const { host, slugs } of hostsWithoutPage(current)) {
    findings.push({
      kind: "missing_entity",
      key: `entity:${host}`,
      title: host,
      slugs,
      suggestedSlug: host,
    });
  }

  const today = new Date();
  for (const page of current) {
    if (isStaleVerification(page.verifiedOn, today)) {
      findings.push({
        kind: "stale_page",
        key: `stale:${page.slug}`,
        title: page.title,
        detail: page.verifiedOn,
        slugs: [page.slug],
      });
    }
    const relative = relativeDateLines(page.content);
    if (relative.length > 0) {
      findings.push({
        kind: "relative_date",
        key: `relative:${page.slug}`,
        title: page.title,
        detail: relative.join("\n"),
        slugs: [page.slug],
      });
    }
  }

  let opened = 0;
  for (const finding of findings) {
    if (await raiseReviewItem(db, officeId, finding)) {
      opened++;
    }
  }

  const keys = findings.map((finding) => finding.key as string);
  const closed = await db
    .update(wikiReviewItems)
    .set({ status: "done", resolvedAt: new Date(), resolvedByUserId: null })
    .where(
      and(
        eq(wikiReviewItems.officeId, officeId),
        eq(wikiReviewItems.status, "open"),
        inArray(wikiReviewItems.kind, [...WIKI_LINT_KINDS]),
        isNotNull(wikiReviewItems.key),
        keys.length > 0 ? sql`${wikiReviewItems.key} not in ${keys}` : undefined,
      ),
    )
    .returning({ id: wikiReviewItems.id });

  return { opened, closed: closed.length };
}

// Points a page loses for each problem.
const HEALTH_PENALTIES: Record<WikiHealthProblem, number> = {
  no_links: 15,
  no_backlinks: 15,
  no_sources: 10,
  too_long: 15,
  stale: 20,
  relative_dates: 10,
  outdated_unlinked: 20,
  open_reviews: 10,
};
// Beyond this a page is several topics, and too much to read in one go.
const HEALTH_MAX_CHARACTERS = 40_000;

// Health of every page of the office, worst first; healthy pages are left out.
export async function wikiHealth(db: Db, officeId: string): Promise<WikiPageHealth[]> {
  const [pages, outgoing, incoming, reviews] = await Promise.all([
    db
      .select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        type: wikiPages.type,
        status: wikiPages.status,
        content: wikiPages.content,
        sources: wikiPages.sources,
        verifiedOn: wikiPages.verifiedOn,
      })
      .from(wikiPages)
      .where(eq(wikiPages.officeId, officeId)),
    db
      .selectDistinct({ slug: wikiPages.slug })
      .from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
      .where(eq(wikiPages.officeId, officeId)),
    db
      .selectDistinct({ slug: wikiLinks.targetSlug })
      .from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
      .where(
        and(eq(wikiPages.officeId, officeId), sql`${wikiLinks.targetSlug} <> ${wikiPages.slug}`),
      ),
    db
      .select({ slugs: wikiReviewItems.slugs })
      .from(wikiReviewItems)
      .where(and(eq(wikiReviewItems.officeId, officeId), eq(wikiReviewItems.status, "open"))),
  ]);
  const linking = new Set(outgoing.map((row) => row.slug));
  const linked = new Set(incoming.map((row) => row.slug));
  const openReviews = new Map<string, number>();
  for (const { slugs } of reviews) {
    for (const slug of slugs) {
      openReviews.set(slug, (openReviews.get(slug) ?? 0) + 1);
    }
  }
  const today = new Date();
  const health: WikiPageHealth[] = [];
  for (const page of pages) {
    const problems: WikiHealthProblem[] = [];
    const current = page.status === "current";
    if (!linking.has(page.slug) && (current || page.type !== "overview")) {
      problems.push(current ? "no_links" : "outdated_unlinked");
    }
    if (!linked.has(page.slug) && page.type !== "overview" && current) {
      problems.push("no_backlinks");
    }
    if (page.sources.length === 0) {
      problems.push("no_sources");
    }
    if (page.content.length > HEALTH_MAX_CHARACTERS) {
      problems.push("too_long");
    }
    if (current && isStaleVerification(page.verifiedOn, today)) {
      problems.push("stale");
    }
    if (current && relativeDateLines(page.content, 1).length > 0) {
      problems.push("relative_dates");
    }
    const open = openReviews.get(page.slug) ?? 0;
    if (open > 0) {
      problems.push("open_reviews");
    }
    const penalty = problems.reduce(
      (sum, problem) =>
        sum + HEALTH_PENALTIES[problem] * (problem === "open_reviews" ? Math.min(open, 3) : 1),
      0,
    );
    if (problems.length > 0) {
      health.push({
        slug: page.slug,
        title: page.title,
        status: page.status,
        score: Math.max(0, 100 - penalty),
        problems,
      });
    }
  }
  return health.sort((x, y) => x.score - y.score || x.title.localeCompare(y.title));
}

// Nightly lint (R-MEM-7): most edits come from conversations, which never trigger the lint a
// filed document does, so every office is checked once a day, after 02:00 server time, without
// a model. The day of the last run is kept in the settings, so a restart does not run it twice.
const LINT_DAY_KEY = "wiki_lint_last_day";

export async function lintAllOffices(db: Db, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const [last] = await db.select().from(settings).where(eq(settings.key, LINT_DAY_KEY));
  if (now.getHours() < 2 || last?.value === day) {
    return false;
  }
  await db
    .insert(settings)
    .values({ key: LINT_DAY_KEY, value: day })
    .onConflictDoUpdate({ target: settings.key, set: { value: day } });
  for (const office of await db.select({ id: offices.id }).from(offices)) {
    await lintWiki(db, office.id).catch((error: unknown) => {
      console.warn("Nightly wiki lint failed", error);
    });
  }
  return true;
}

export function startWikiLintWorker(db: Db, intervalMs = 15 * 60_000) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  async function tick() {
    try {
      await lintAllOffices(db);
    } catch (error) {
      console.error("Nightly wiki lint worker failed", error);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  }
  timer = setTimeout(() => void tick(), 60_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// Proposals (R-MEM-3): a colleague working for someone who may not edit the wiki writes nothing;
// its change waits in the review queue for an office manager.
export async function proposeChange(
  db: DbExecutor,
  officeId: string,
  colleagueId: string,
  proposal: WikiProposal,
) {
  const [row] = await db
    .insert(wikiReviewItems)
    .values({
      officeId,
      kind: "proposal",
      key: null,
      title: proposal.title.slice(0, 300),
      detail: proposal.summary?.slice(0, 4_000) ?? null,
      slugs: [proposal.slug],
      proposal,
      raisedByColleagueId: colleagueId,
    })
    .returning({ id: wikiReviewItems.id });
  return row?.id ?? null;
}

export type ApplyResult = "applied" | "conflict" | "not_found";

// Applies a proposal as the colleague's revision, on the revision it was written against: a page
// changed since, or created since, is a conflict and the proposal stays open, to be rejected or
// asked again. The office manager who applied it closes the item and is in the log.
export async function applyProposal(
  db: Db,
  officeId: string,
  id: string,
  userId: string,
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(wikiReviewItems)
      .where(
        and(
          eq(wikiReviewItems.id, id),
          eq(wikiReviewItems.officeId, officeId),
          eq(wikiReviewItems.kind, "proposal"),
          eq(wikiReviewItems.status, "open"),
        ),
      )
      .for("update");
    const proposal = item?.proposal;
    if (!item || !proposal) {
      return "not_found";
    }
    const actor = item.raisedByColleagueId
      ? {
          colleagueId: item.raisedByColleagueId,
          ...(proposal.origin ? { origin: proposal.origin } : {}),
        }
      : { userId };
    const current = await findPageRow(tx, officeId, proposal.slug);
    const marks = {
      ...(proposal.status ? { status: proposal.status } : {}),
      ...(proposal.verifiedOn === undefined ? {} : { verifiedOn: proposal.verifiedOn }),
    };
    if (proposal.action === "create") {
      if (current) {
        return "conflict";
      }
      const page = await insertPage(
        tx,
        officeId,
        proposal.slug,
        {
          title: proposal.title,
          section: proposal.section,
          type: proposal.type,
          content: proposal.content,
          sources: proposal.sources,
          ...marks,
        },
        actor,
        proposal.summary,
      );
      await appendLog(tx, {
        officeId,
        action: "create",
        slug: page.slug,
        title: page.title,
        detail: "proposal applied",
        actor: { userId },
      });
    } else {
      if (!current || current.revision !== proposal.baseRevision) {
        return "conflict";
      }
      const saved = await savePageRevision(
        tx,
        current,
        {
          title: proposal.title,
          section: proposal.section,
          type: proposal.type,
          content: proposal.content,
          sources: proposal.sources,
          ...marks,
        },
        actor,
        proposal.summary,
      );
      if (!saved) {
        return "conflict";
      }
      await appendLog(tx, {
        officeId,
        action: "update",
        slug: saved.slug,
        title: saved.title,
        detail: "proposal applied",
        actor: { userId },
      });
    }
    await tx
      .update(wikiReviewItems)
      .set({ status: "done", resolvedAt: new Date(), resolvedByUserId: userId })
      .where(eq(wikiReviewItems.id, id));
    return "applied";
  });
}
