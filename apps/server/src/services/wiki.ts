import {
  extractWikiLinks,
  type Me,
  parseWikiSynonyms,
  WIKI_SEARCH_SYNONYMS,
  type WikiAuthor,
  type WikiColleagueRef,
  type WikiLogAction,
  type WikiLogEntry,
  type WikiOrigin,
  type WikiPage,
  type WikiPageRef,
  type WikiPageStatus,
  type WikiPageSummary,
  type WikiPageType,
  type WikiRevision,
  type WikiRevisionSummary,
  type WikiSearchResult,
} from "@orlok/shared";
import { and, asc, desc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  colleagues,
  officeMembers,
  offices,
  users,
  type WikiPageRow,
  wikiLinks,
  wikiLog,
  wikiPages,
  wikiReviewItems,
  wikiRevisions,
  wikiSources,
} from "../db/schema";
import { buildSearchIndex, rankPages, type SearchIndex } from "./wiki-search";

export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// A change is made by a person from the web app or by a colleague during ingest (R-MEM-3).
export type WikiActor = { userId: string } | { colleagueId: string; origin?: WikiOrigin };

export type WikiPageFields = {
  title: string;
  section: string | null;
  type: WikiPageType;
  content: string;
  sources: string[];
  // Left out: current and never verified for a new page, unchanged for an update.
  status?: WikiPageStatus;
  verifiedOn?: string | null;
};

function actorColumns(actor: WikiActor) {
  return "userId" in actor
    ? { userId: actor.userId, colleagueId: null }
    : { userId: null, colleagueId: actor.colleagueId };
}

// The colleague behind a wiki change, with the person it belongs to: colleagues are personal, so
// two can share a name. Selected through a left join on colleagues and then on colleagueOwners.
export const colleagueOwners = alias(users, "colleague_owner");
export const colleagueRefColumns = {
  colleagueName: colleagues.name,
  colleagueOwner: colleagueOwners.displayName,
  colleagueDeletedAt: colleagues.deletedAt,
};

type ColleagueRefRow = {
  colleagueName: string | null;
  colleagueOwner: string | null;
  colleagueDeletedAt: Date | null;
};

export function toColleagueRef(row: ColleagueRefRow): WikiColleagueRef | null {
  return row.colleagueName === null
    ? null
    : {
        name: row.colleagueName,
        owner: row.colleagueOwner,
        deleted: row.colleagueDeletedAt !== null,
      };
}

function toAuthor(personName: string | null, colleague: ColleagueRefRow): WikiAuthor {
  if (personName !== null) {
    return { kind: "person", name: personName };
  }
  const ref = toColleagueRef(colleague);
  return ref ? { kind: "colleague", ...ref } : null;
}

// Reading is open to everyone who can access the office, editing to administrators and office
// managers (R-MEM-5, R-MEM-9). Offices a person cannot access are reported as missing.
export async function getWikiAccess(db: Db, user: Me, officeId: string) {
  const [office] = await db.select().from(offices).where(eq(offices.id, officeId)).limit(1);
  if (!office) {
    return null;
  }
  if (user.role === "admin") {
    return { office, canEdit: true };
  }
  const [membership] = await db
    .select({ role: officeMembers.role })
    .from(officeMembers)
    .where(and(eq(officeMembers.officeId, officeId), eq(officeMembers.userId, user.id)))
    .limit(1);
  return membership ? { office, canEdit: membership.role === "manager" } : null;
}

// --- Search ----------------------------------------------------------------------------------

const summaryColumns = {
  slug: wikiPages.slug,
  title: wikiPages.title,
  section: wikiPages.section,
  type: wikiPages.type,
  status: wikiPages.status,
  updatedAt: wikiPages.updatedAt,
};

function toSummary(row: {
  slug: string;
  title: string;
  section: string | null;
  type: WikiPageType;
  status: WikiPageStatus;
  updatedAt: Date;
}): WikiPageSummary {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

// Each office's word index, rebuilt when a page is added, changed or removed.
const searchIndexes = new Map<string, { key: string; index: SearchIndex }>();

async function officeSearchIndex(db: Db, officeId: string) {
  const [state] = await db
    .select({
      pages: sql<number>`count(*)`,
      updatedAt: sql<string>`max(${wikiPages.updatedAt})::text`,
    })
    .from(wikiPages)
    .where(eq(wikiPages.officeId, officeId));
  const key = `${state?.pages ?? 0}:${state?.updatedAt ?? ""}`;
  const cached = searchIndexes.get(officeId);
  if (cached?.key === key) {
    return cached.index;
  }
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      section: wikiPages.section,
      content: wikiPages.content,
      status: wikiPages.status,
    })
    .from(wikiPages)
    .where(eq(wikiPages.officeId, officeId));
  const index = buildSearchIndex(
    rows.map(({ status, ...page }) => ({ ...page, outdated: status !== "current" })),
  );
  searchIndexes.set(officeId, { key, index });
  return index;
}

// The built-in synonym groups plus the office's own.
async function officeSynonyms(db: Db, officeId: string) {
  const [office] = await db
    .select({ synonyms: offices.wikiSynonyms })
    .from(offices)
    .where(eq(offices.id, officeId));
  return [...WIKI_SEARCH_SYNONYMS, ...parseWikiSynonyms(office?.synonyms)];
}

// Word search (R-MEM-4), ranked by `rankPages`: best first, scores comparable only within one
// search.
export async function searchPages(
  db: Db,
  officeId: string,
  text: string,
  limit = 20,
): Promise<(WikiSearchResult & { telling: number })[]> {
  const [index, synonyms] = await Promise.all([
    officeSearchIndex(db, officeId),
    officeSynonyms(db, officeId),
  ]);
  const ranked = rankPages(index, text, { limit, synonyms });
  if (ranked.length === 0) {
    return [];
  }
  const rows = await db
    .select(summaryColumns)
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.officeId, officeId),
        inArray(
          wikiPages.slug,
          ranked.map((page) => page.slug),
        ),
      ),
    );
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return ranked.flatMap((page) => {
    const row = bySlug.get(page.slug);
    return row
      ? [{ ...toSummary(row), snippet: page.snippet, rank: page.score, telling: page.telling }]
      : [];
  });
}

export type ContextPage = WikiPageRef & { content: string; status?: WikiPageStatus };

// --- Reading ---------------------------------------------------------------------------------

export async function listPages(db: Db, officeId: string): Promise<WikiPageSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(wikiPages)
    .where(eq(wikiPages.officeId, officeId))
    .orderBy(sql`${wikiPages.section} asc nulls first`, asc(wikiPages.title));
  return rows.map(toSummary);
}

export async function findPageRow(db: DbExecutor, officeId: string, slug: string) {
  const [row] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.officeId, officeId), eq(wikiPages.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function getPage(db: Db, officeId: string, slug: string): Promise<WikiPage | null> {
  const [row] = await db
    .select({
      page: getTableColumns(wikiPages),
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(wikiPages)
    .leftJoin(users, eq(wikiPages.updatedByUserId, users.id))
    .leftJoin(colleagues, eq(wikiPages.updatedByColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(and(eq(wikiPages.officeId, officeId), eq(wikiPages.slug, slug)))
    .limit(1);
  if (!row) {
    return null;
  }
  const backlinks = await db
    .selectDistinct({ slug: wikiPages.slug, title: wikiPages.title })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
    .where(
      and(
        eq(wikiPages.officeId, officeId),
        eq(wikiLinks.targetSlug, slug),
        ne(wikiPages.slug, slug),
      ),
    )
    .orderBy(asc(wikiPages.title));

  const { page } = row;
  return {
    id: page.id,
    ...toSummary(page),
    content: page.content,
    sources: page.sources,
    verifiedOn: page.verifiedOn,
    revision: page.revision,
    updatedBy: toAuthor(row.personName, row),
    createdAt: page.createdAt.toISOString(),
    backlinks,
  };
}

export async function listRevisions(db: Db, pageId: string): Promise<WikiRevisionSummary[]> {
  const rows = await db
    .select({
      revision: wikiRevisions.revision,
      title: wikiRevisions.title,
      summary: wikiRevisions.summary,
      origin: wikiRevisions.origin,
      createdAt: wikiRevisions.createdAt,
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(wikiRevisions)
    .leftJoin(users, eq(wikiRevisions.authorUserId, users.id))
    .leftJoin(colleagues, eq(wikiRevisions.authorColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(eq(wikiRevisions.pageId, pageId))
    .orderBy(desc(wikiRevisions.revision));
  return rows.map(
    ({ personName, colleagueName, colleagueOwner, colleagueDeletedAt, createdAt, ...rest }) => ({
      ...rest,
      author: toAuthor(personName, { colleagueName, colleagueOwner, colleagueDeletedAt }),
      createdAt: createdAt.toISOString(),
    }),
  );
}

export async function getRevision(
  db: Db,
  pageId: string,
  revision: number,
): Promise<WikiRevision | null> {
  const [row] = await db
    .select({
      revision: getTableColumns(wikiRevisions),
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(wikiRevisions)
    .leftJoin(users, eq(wikiRevisions.authorUserId, users.id))
    .leftJoin(colleagues, eq(wikiRevisions.authorColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(and(eq(wikiRevisions.pageId, pageId), eq(wikiRevisions.revision, revision)))
    .limit(1);
  if (!row) {
    return null;
  }
  const { revision: item } = row;
  return {
    revision: item.revision,
    title: item.title,
    summary: item.summary,
    author: toAuthor(row.personName, row),
    origin: item.origin,
    createdAt: item.createdAt.toISOString(),
    section: item.section,
    type: item.type,
    status: item.status,
    verifiedOn: item.verifiedOn,
    content: item.content,
    sources: item.sources,
  };
}

export async function listLog(db: Db, officeId: string, limit = 100): Promise<WikiLogEntry[]> {
  const rows = await db
    .select({
      id: wikiLog.id,
      action: wikiLog.action,
      slug: wikiLog.slug,
      title: wikiLog.title,
      detail: wikiLog.detail,
      createdAt: wikiLog.createdAt,
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(wikiLog)
    .leftJoin(users, eq(wikiLog.authorUserId, users.id))
    .leftJoin(colleagues, eq(wikiLog.authorColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(eq(wikiLog.officeId, officeId))
    .orderBy(desc(wikiLog.createdAt))
    .limit(limit);
  return rows.map(
    ({ personName, colleagueName, colleagueOwner, colleagueDeletedAt, createdAt, ...rest }) => ({
      ...rest,
      author: toAuthor(personName, { colleagueName, colleagueOwner, colleagueDeletedAt }),
      createdAt: createdAt.toISOString(),
    }),
  );
}

// --- Writing ---------------------------------------------------------------------------------

export async function appendLog(
  db: DbExecutor,
  entry: {
    officeId: string;
    action: WikiLogAction;
    slug: string | null;
    title: string;
    detail?: string | null;
    actor: WikiActor;
  },
) {
  const { userId, colleagueId } = actorColumns(entry.actor);
  await db.insert(wikiLog).values({
    officeId: entry.officeId,
    action: entry.action,
    slug: entry.slug,
    title: entry.title,
    detail: entry.detail ?? null,
    authorUserId: userId,
    authorColleagueId: colleagueId,
  });
}

async function replaceLinks(db: DbExecutor, pageId: string, content: string) {
  await db.delete(wikiLinks).where(eq(wikiLinks.pageId, pageId));
  const targets = extractWikiLinks(content);
  if (targets.length > 0) {
    await db.insert(wikiLinks).values(targets.map((targetSlug) => ({ pageId, targetSlug })));
  }
}

async function insertRevision(
  db: DbExecutor,
  page: WikiPageRow,
  actor: WikiActor,
  summary: string | null,
) {
  const { userId, colleagueId } = actorColumns(actor);
  await db.insert(wikiRevisions).values({
    pageId: page.id,
    revision: page.revision,
    title: page.title,
    section: page.section,
    type: page.type,
    content: page.content,
    sources: page.sources,
    status: page.status,
    verifiedOn: page.verifiedOn,
    summary,
    authorUserId: userId,
    authorColleagueId: colleagueId,
    origin: "origin" in actor && actor.origin ? actor.origin : null,
  });
}

// Creates a page with its first revision. Logging is left to the caller.
export async function insertPage(
  db: DbExecutor,
  officeId: string,
  slug: string,
  fields: WikiPageFields,
  actor: WikiActor,
  summary: string | null,
) {
  const { userId, colleagueId } = actorColumns(actor);
  const [page] = await db
    .insert(wikiPages)
    .values({
      officeId,
      slug,
      ...fields,
      updatedByUserId: userId,
      updatedByColleagueId: colleagueId,
    })
    .returning();
  if (!page) {
    throw new Error("Wiki page insert returned no row");
  }
  await insertRevision(db, page, actor, summary);
  await replaceLinks(db, page.id, page.content);
  return page;
}

// Saves a new revision of a page. Returns null when the page changed since `current` was read.
export async function savePageRevision(
  db: DbExecutor,
  current: WikiPageRow,
  changes: Partial<WikiPageFields>,
  actor: WikiActor,
  summary: string | null,
) {
  const fields: WikiPageFields = {
    title: changes.title ?? current.title,
    section: changes.section === undefined ? current.section : changes.section,
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    sources: changes.sources ?? current.sources,
    status: changes.status ?? current.status,
    verifiedOn: changes.verifiedOn === undefined ? current.verifiedOn : changes.verifiedOn,
  };
  const { userId, colleagueId } = actorColumns(actor);
  const [page] = await db
    .update(wikiPages)
    .set({
      ...fields,
      revision: current.revision + 1,
      updatedByUserId: userId,
      updatedByColleagueId: colleagueId,
    })
    .where(and(eq(wikiPages.id, current.id), eq(wikiPages.revision, current.revision)))
    .returning();
  if (!page) {
    return null;
  }
  await insertRevision(db, page, actor, summary);
  if (fields.content !== current.content) {
    await replaceLinks(db, page.id, page.content);
  }
  return page;
}

export function sameFields(page: WikiPageRow, fields: WikiPageFields) {
  return (
    page.title === fields.title &&
    page.section === fields.section &&
    page.type === fields.type &&
    page.content === fields.content &&
    JSON.stringify(page.sources) === JSON.stringify(fields.sources) &&
    (fields.status === undefined || page.status === fields.status) &&
    (fields.verifiedOn === undefined || page.verifiedOn === fields.verifiedOn)
  );
}

// Empties the wiki of an office, so it can be imported again from scratch: pages with their
// revisions, links and embeddings, the log, the documents and the review queue. Settings such as
// the synonyms stay. Refused while a document is being read, which would write pages meanwhile.
export async function clearWiki(db: Db, officeId: string) {
  return db.transaction(async (tx) => {
    const [busy] = await tx
      .select({ id: wikiSources.id })
      .from(wikiSources)
      .where(and(eq(wikiSources.officeId, officeId), eq(wikiSources.status, "processing")))
      .limit(1)
      .for("update");
    if (busy) {
      return null;
    }
    const pages = await tx
      .delete(wikiPages)
      .where(eq(wikiPages.officeId, officeId))
      .returning({ id: wikiPages.id });
    const sources = await tx
      .delete(wikiSources)
      .where(eq(wikiSources.officeId, officeId))
      .returning({ id: wikiSources.id });
    await tx.delete(wikiLog).where(eq(wikiLog.officeId, officeId));
    await tx.delete(wikiReviewItems).where(eq(wikiReviewItems.officeId, officeId));
    return { pages: pages.length, sources: sources.length };
  });
}

export async function countWikiPages(db: Db) {
  const rows = await db
    .select({ officeId: wikiPages.officeId, count: sql<number>`count(*)::int` })
    .from(wikiPages)
    .groupBy(wikiPages.officeId);
  return new Map(rows.map((row) => [row.officeId, row.count]));
}
