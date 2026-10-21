import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { wikiPages } from "../db/schema";
import { type Embedder, semanticSearch } from "./embeddings";
import { type ContextPage, searchPages } from "./wiki";
import { expandScores, getWikiGraph } from "./wiki-graph";
import { fold, stem, termGroups } from "./wiki-search";

// Retrieval for virtual colleagues (R-MEM-4): full-text search, semantic
// search when embeddings are configured, then expansion over the knowledge graph.

export type RetrievedPage = {
  slug: string;
  title: string;
  score: number;
  via: "search" | "semantic" | "graph";
  snippet: string | null;
};

// Full-text matches below this share of the best one are left out.
const MIN_RELATIVE_RANK = 0.5;
// What meaning adds to a page the words found too, by its place between the nearest and the
// farthest candidate: the small built-in model ranks well, but its similarities crowd together
// (unrelated pages score nearly as high as the right one), so they tell little on their own.
const SEMANTIC_BOOST = 0.3;
// Pages found by meaning alone are taken from the first few, next to pages the words found. When
// the words found nothing (another language, other words for the same thing), one counts only if
// it stands out from the rest: on its own the built-in model would always find something.
const SEMANTIC_ALONE = 3;
const SEMANTIC_STANDOUT = 1;
const SEEDS = 6;
// Pages scoring below this share of the best page are left out, so a question about one thing
// gets one page rather than five.
const MIN_RELATIVE_SCORE = 0.4;

export async function retrievePages(
  db: Db,
  officeId: string,
  query: string,
  { embedder = null, limit = 10 }: { embedder?: Embedder | null; limit?: number } = {},
): Promise<RetrievedPage[]> {
  const [text, semantic] = await Promise.all([
    searchPages(db, officeId, query, 20),
    embedder
      ? semanticSearch(db, officeId, embedder, query, 20).catch((error: unknown) => {
          // A failing embedding provider must not break answers: full-text search still works.
          console.warn("Semantic search failed", error);
          return [];
        })
      : Promise.resolve([]),
  ]);

  // The words must have found the subject: a page counts only if it holds a word of the query
  // that few pages hold. Small talk ("ok", "verifica ora") finds nothing and gets nothing.
  const found = new Map<string, RetrievedPage>();
  for (const page of text) {
    if (page.telling === 0 || page.rank < MIN_RELATIVE_RANK) {
      continue;
    }
    found.set(page.slug, {
      slug: page.slug,
      title: page.title,
      score: page.rank,
      via: "search",
      snippet: page.snippet,
    });
  }
  const wordsFound = found.size > 0;
  const best = semantic[0]?.similarity ?? 0;
  const worst = semantic.at(-1)?.similarity ?? 0;
  semantic.forEach((page, rank) => {
    const closeness = best > worst ? (page.similarity - worst) / (best - worst) : 1;
    const existing = found.get(page.slug);
    if (existing) {
      existing.score += SEMANTIC_BOOST * closeness;
    } else if (rank < SEMANTIC_ALONE && (wordsFound || semantic.length <= SEMANTIC_STANDOUT)) {
      found.set(page.slug, {
        slug: page.slug,
        title: page.title,
        score: SEMANTIC_BOOST * closeness,
        via: "semantic",
        snippet: null,
      });
    }
  });
  if (found.size === 0) {
    return [];
  }

  const ranked = [...found.values()].sort((x, y) => y.score - x.score);
  const seeds = new Map(ranked.slice(0, SEEDS).map((page) => [page.slug, page.score]));
  const graph = await getWikiGraph(db, officeId);
  const titles = new Map(graph.nodes.map((node) => [node.slug, node.title]));
  for (const [slug, score] of expandScores(graph, seeds)) {
    const existing = found.get(slug);
    if (existing) {
      existing.score = Math.max(existing.score, score);
    } else if (titles.has(slug)) {
      found.set(slug, {
        slug,
        title: titles.get(slug) ?? slug,
        score,
        via: "graph",
        snippet: null,
      });
    }
  }
  const all = [...found.values()].sort((x, y) => y.score - x.score);
  const top = all[0]?.score ?? 0;
  return all.filter((page) => page.score >= top * MIN_RELATIVE_SCORE).slice(0, limit);
}

const CONTEXT_PAGES = 5;
const CONTEXT_PAGE_CHARS = 6_000;
const CONTEXT_TOTAL_CHARS = 18_000;

// Pages given to a colleague before answering, shortened to fit the prompt. Pages found only
// through the graph are included when they rank among the best. On a small model the wiki gets
// less room: it travels in the system prompt, where nothing can shorten it afterwards (R-MOD-6).
export async function retrieveContextPages(
  db: Db,
  officeId: string,
  query: string,
  embedder: Embedder | null,
  maxCharacters = CONTEXT_TOTAL_CHARS,
): Promise<ContextPage[]> {
  const retrieved = await retrievePages(db, officeId, query, { embedder, limit: CONTEXT_PAGES });
  if (retrieved.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      content: wikiPages.content,
      status: wikiPages.status,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.officeId, officeId),
        inArray(
          wikiPages.slug,
          retrieved.map((page) => page.slug),
        ),
      ),
    );
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  let remaining = Math.max(1_000, Math.min(CONTEXT_TOTAL_CHARS, maxCharacters));
  const pages: ContextPage[] = [];
  for (const { slug } of retrieved) {
    const row = bySlug.get(slug);
    if (!row || remaining <= 0) {
      continue;
    }
    const limit = Math.min(CONTEXT_PAGE_CHARS, remaining);
    const content = passageFor(row.content, query, limit);
    remaining -= content.length;
    pages.push({ ...row, content });
  }
  return pages;
}

// A follow-up says little on its own ("e su bak06?"): when the latest message is short, the
// question before it is searched too, so the pages of the topic still come back.
const SHORT_FOLLOW_UP = 80;

export function conversationQuery(latest: string, earlierUserMessages: string[]) {
  const previous = earlierUserMessages.at(-1);
  return latest.trim().length < SHORT_FOLLOW_UP && previous ? `${previous}\n${latest}` : latest;
}

const HEAD_CHARS = 800;
const WORDS = /[\p{L}\p{N}_]+/gu;

// What of a long page goes to the colleague: its beginning, which says what the page is about,
// then the run of lines where the words of the question gather, instead of only the first
// characters, which on a long imported note rarely hold the answer. Short pages go whole.
export function passageFor(content: string, query: string, limit: number) {
  if (content.length <= limit) {
    return content;
  }
  const headOnly = `${content.slice(0, limit)}\n[… truncated]`;
  const groups = termGroups(query).map((group) => new Set(group.map((item) => item.term)));
  if (groups.length === 0) {
    return headOnly;
  }
  const lines = content.split("\n");
  // Where the head ends: whole lines up to HEAD_CHARS (or a quarter of a small limit).
  const headBudget = Math.min(HEAD_CHARS, Math.floor(limit / 4));
  let headLines = 0;
  let headLength = 0;
  while (
    headLines < lines.length &&
    headLength + (lines[headLines]?.length ?? 0) + 1 <= headBudget
  ) {
    headLength += (lines[headLines]?.length ?? 0) + 1;
    headLines++;
  }
  const scores = lines.map((line) => {
    const stems = new Set((fold(line).match(WORDS) ?? []).map(stem));
    return groups.filter((group) => [...group].some((term) => stems.has(term))).length;
  });
  // The window after the head with the most matching lines that fits what is left.
  const budget = limit - headLength - 40;
  let best = { start: -1, end: -1, score: 0 };
  let start = headLines;
  let length = 0;
  let score = 0;
  for (let end = headLines; end < lines.length; end++) {
    length += (lines[end]?.length ?? 0) + 1;
    score += scores[end] ?? 0;
    while (length > budget && start <= end) {
      length -= (lines[start]?.length ?? 0) + 1;
      score -= scores[start] ?? 0;
      start++;
    }
    if (start <= end && score > best.score) {
      best = { start, end, score };
    }
  }
  if (best.score === 0) {
    return headOnly;
  }
  const head = lines.slice(0, headLines).join("\n");
  const window = lines.slice(best.start, best.end + 1).join("\n");
  return [
    head,
    best.start > headLines ? "[…]" : "",
    window,
    best.end < lines.length - 1 ? "[… truncated]" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
