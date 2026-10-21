import { slugify, WIKI_LINK_PATTERN, type WikiSourceDeleteResult } from "@orlok/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { wikiLinks, wikiPages, wikiSources } from "../db/schema";
import { appendLog, type DbExecutor, savePageRevision, type WikiActor } from "./wiki";

// Tag written in the sources of every page filed from a document (see wiki-ingest).
export function documentSourceTag(fileName: string) {
  return `Document: ${fileName}`;
}

// Replaces links to the given pages with their label or title, leaving code untouched.
export function stripWikiLinks(content: string, targets: ReadonlyMap<string, string>) {
  return content
    .split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[^\n]*$)/m)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            new RegExp(WIKI_LINK_PATTERN.source, "g"),
            (link, target: string, label: string | undefined) => {
              const title = targets.get(slugify(target));
              return title === undefined ? link : label?.trim() || title;
            },
          ),
    )
    .join("");
}

async function removeLinksTo(
  db: DbExecutor,
  officeId: string,
  targets: ReadonlyMap<string, string>,
  actor: WikiActor,
) {
  if (targets.size === 0) {
    return [];
  }
  const linking = await db
    .selectDistinct({ id: wikiPages.id })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
    .where(
      and(eq(wikiPages.officeId, officeId), inArray(wikiLinks.targetSlug, [...targets.keys()])),
    );
  const updated: string[] = [];
  for (const { id } of linking) {
    const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!page) {
      continue;
    }
    const content = stripWikiLinks(page.content, targets);
    if (content !== page.content) {
      await savePageRevision(db, page, { content }, actor, "Removed links to deleted pages");
      updated.push(page.slug);
    }
  }
  return updated;
}

// Deletes a document and what was written only from it: its source page
// and pages with no other source go away, shared pages just lose the source, and links to the
// deleted pages are removed. Every change keeps its revision history.
export async function deleteSourceWithPages(
  db: Db,
  officeId: string,
  source: { id: string; fileName: string },
  actor: WikiActor,
): Promise<WikiSourceDeleteResult> {
  const tag = documentSourceTag(source.fileName);
  return db.transaction(async (tx) => {
    const pages = await tx
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.officeId, officeId),
          sql`${wikiPages.sources} @> ${JSON.stringify([tag])}::jsonb`,
        ),
      );
    const deleted = new Map<string, string>();
    const updated = new Set<string>();
    for (const page of pages) {
      const others = page.sources.filter((item) => item !== tag);
      if (page.type === "source" || others.length === 0) {
        await tx.delete(wikiPages).where(eq(wikiPages.id, page.id));
        await appendLog(tx, {
          officeId,
          action: "delete",
          slug: page.slug,
          title: page.title,
          detail: `with document ${source.fileName}`,
          actor,
        });
        deleted.set(page.slug, page.title);
      } else {
        await savePageRevision(
          tx,
          page,
          { sources: others },
          actor,
          `Removed source ${source.fileName}`,
        );
        updated.add(page.slug);
      }
    }
    for (const slug of await removeLinksTo(tx, officeId, deleted, actor)) {
      updated.add(slug);
    }
    await tx.delete(wikiSources).where(eq(wikiSources.id, source.id));
    return { deletedPages: [...deleted.keys()], updatedPages: [...updated] };
  });
}
