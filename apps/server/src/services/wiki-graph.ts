import {
  WIKI_RELEVANCE_WEIGHTS,
  type WikiCommunity,
  type WikiGraph,
  type WikiGraphEdge,
  type WikiPageType,
  type WikiRelatedPage,
  type WikiRelevanceSignals,
  type WikiSurpriseReason,
} from "@orlok/shared";
import { eq, sql } from "drizzle-orm";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { Db } from "../db/client";
import { wikiEmbeddings, wikiLinks, wikiPages } from "../db/schema";
import { semanticNeighbors } from "./embeddings";

// Relevance between wiki pages: direct links, shared sources, common
// neighbors (Adamic-Adar) and type affinity, plus semantic similarity when embeddings exist.

type GraphPage = {
  slug: string;
  title: string;
  type: WikiPageType;
  section: string | null;
  sources: string[];
};

export type GraphInput = {
  pages: GraphPage[];
  links: { from: string; to: string }[];
  semantic: { a: string; b: string; similarity: number }[];
};

// A source cited by very many pages (e.g. a large import) says little about each pair.
const MAX_PAGES_PER_SOURCE = 25;
// Hubs (overviews, indexes) linking many pages would relate all of them to each other.
const MAX_COMMON_NEIGHBOR_DEGREE = 30;
const ISOLATED_MAX_DEGREE = 1;
const SPARSE_COHESION = 0.15;
const SPARSE_MIN_SIZE = 3;
const BRIDGE_MIN_COMMUNITIES = 3;
const SURPRISING_MIN_WEIGHT = WIKI_RELEVANCE_WEIGHTS.links;
const SURPRISING_MAX = 12;

function emptySignals(): WikiRelevanceSignals {
  return { links: 0, sources: 0, adamicAdar: 0, type: 0, semantic: 0 };
}

export function relevanceWeight(signals: WikiRelevanceSignals) {
  return (
    signals.links * WIKI_RELEVANCE_WEIGHTS.links +
    signals.sources * WIKI_RELEVANCE_WEIGHTS.sources +
    signals.adamicAdar * WIKI_RELEVANCE_WEIGHTS.adamicAdar +
    signals.type * WIKI_RELEVANCE_WEIGHTS.type +
    signals.semantic * WIKI_RELEVANCE_WEIGHTS.semantic
  );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// Deterministic random numbers, so communities do not change between identical requests.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeGraph({ pages, links, semantic }: GraphInput): WikiGraph {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const pairs = new Map<string, { a: string; b: string; signals: WikiRelevanceSignals }>();
  const signalsOf = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { a, b, signals: emptySignals() };
      pairs.set(key, pair);
    }
    return pair.signals;
  };

  const adjacency = new Map<string, Set<string>>();
  for (const { from, to } of links) {
    if (from === to || !bySlug.has(from) || !bySlug.has(to)) {
      continue;
    }
    // A link in both directions counts twice.
    signalsOf(from, to).links += 1;
    for (const [x, y] of [
      [from, to],
      [to, from],
    ] as const) {
      const set = adjacency.get(x) ?? new Set<string>();
      set.add(y);
      adjacency.set(x, set);
    }
  }

  const pagesBySource = new Map<string, string[]>();
  for (const page of pages) {
    for (const source of new Set(page.sources.map((item) => item.trim().toLowerCase()))) {
      if (source) {
        pagesBySource.set(source, [...(pagesBySource.get(source) ?? []), page.slug]);
      }
    }
  }
  for (const members of pagesBySource.values()) {
    if (members.length < 2 || members.length > MAX_PAGES_PER_SOURCE) {
      continue;
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        signalsOf(members[i] as string, members[j] as string).sources += 1;
      }
    }
  }

  // Common neighbors weighted by 1 / log(degree): sharing a rare neighbor means more.
  for (const [slug, neighbors] of adjacency) {
    if (
      neighbors.size < 2 ||
      neighbors.size > MAX_COMMON_NEIGHBOR_DEGREE ||
      bySlug.get(slug)?.type === "overview"
    ) {
      continue;
    }
    const weight = 1 / Math.log(neighbors.size);
    const list = [...neighbors];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        signalsOf(list[i] as string, list[j] as string).adamicAdar += weight;
      }
    }
  }

  // Similarity scales differ between models (e5 stays around 0.8–0.95): rescale nearest-neighbor
  // similarities from their median (0) to their maximum (1) and keep the upper half.
  const similarities = semantic.map((item) => item.similarity).sort((x, y) => x - y);
  const median = similarities[Math.floor(similarities.length / 2)] ?? 0;
  const top = similarities.at(-1) ?? 0;
  for (const { a, b, similarity } of semantic) {
    const scaled = top > median ? (similarity - median) / (top - median) : 1;
    if (a !== b && scaled > 0 && bySlug.has(a) && bySlug.has(b)) {
      const signals = signalsOf(a, b);
      signals.semantic = Math.max(signals.semantic, Math.min(1, scaled));
    }
  }

  const edges: WikiGraphEdge[] = [];
  for (const { a, b, signals } of pairs.values()) {
    // Type affinity only strengthens pairs that are already related.
    if (bySlug.get(a)?.type === bySlug.get(b)?.type) {
      signals.type = 1;
    }
    const rounded: WikiRelevanceSignals = {
      links: signals.links,
      sources: signals.sources,
      adamicAdar: round(signals.adamicAdar),
      type: signals.type,
      semantic: round(signals.semantic),
    };
    const weight = relevanceWeight(rounded);
    if (weight > rounded.type * WIKI_RELEVANCE_WEIGHTS.type) {
      edges.push({ source: a, target: b, weight: round(weight), signals: rounded });
    }
  }
  edges.sort((x, y) => y.weight - x.weight);

  const graph = new Graph({ type: "undirected" });
  for (const page of pages) {
    graph.addNode(page.slug);
  }
  for (const edge of edges) {
    graph.addEdge(edge.source, edge.target, { weight: edge.weight });
  }

  const rawCommunities: Record<string, number> =
    graph.size > 0 ? louvain(graph, { getEdgeWeight: "weight", rng: seededRandom(42) }) : {};
  // Pages without edges form their own community; ids are renumbered by size.
  let nextRaw = Math.max(-1, ...Object.values(rawCommunities)) + 1;
  const rawOf = (slug: string) => {
    if (rawCommunities[slug] === undefined) {
      rawCommunities[slug] = nextRaw++;
    }
    return rawCommunities[slug] as number;
  };
  const members = new Map<number, string[]>();
  for (const page of pages) {
    const raw = rawOf(page.slug);
    members.set(raw, [...(members.get(raw) ?? []), page.slug]);
  }
  const ordered = [...members.entries()].sort(
    (x, y) => y[1].length - x[1].length || (x[1][0] ?? "").localeCompare(y[1][0] ?? ""),
  );
  const communityOf = new Map<string, number>();
  ordered.forEach(([, slugs], id) => {
    for (const slug of slugs) {
      communityOf.set(slug, id);
    }
  });

  const internalEdges = new Map<number, number>();
  for (const edge of edges) {
    const community = communityOf.get(edge.source);
    if (community !== undefined && community === communityOf.get(edge.target)) {
      internalEdges.set(community, (internalEdges.get(community) ?? 0) + 1);
    }
  }
  const communities: WikiCommunity[] = ordered.map(([, slugs], id) => {
    const size = slugs.length;
    const hub = [...slugs].sort((x, y) => graph.degree(y) - graph.degree(x))[0] ?? "";
    return {
      id,
      size,
      cohesion: size > 1 ? round((internalEdges.get(id) ?? 0) / ((size * (size - 1)) / 2)) : 1,
      label: bySlug.get(hub)?.title ?? hub,
    };
  });

  const nodes = pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    type: page.type,
    section: page.section,
    degree: graph.degree(page.slug),
    community: communityOf.get(page.slug) ?? 0,
  }));

  const degrees = nodes.map((node) => node.degree).sort((x, y) => x - y);
  const hubDegree = Math.max(8, degrees[Math.floor(degrees.length * 0.9)] ?? 0);
  // Overview and source pages link across topics by design: their edges are never surprising.
  const connective = (slug: string) => {
    const type = bySlug.get(slug)?.type;
    return type === "overview" || type === "source";
  };
  const surprising = edges
    .filter(
      (edge) =>
        edge.weight >= SURPRISING_MIN_WEIGHT &&
        !connective(edge.source) &&
        !connective(edge.target),
    )
    .map((edge) => {
      const reasons: WikiSurpriseReason[] = [];
      if (communityOf.get(edge.source) !== communityOf.get(edge.target)) {
        reasons.push("cross_community");
      }
      const typeA = bySlug.get(edge.source)?.type;
      const typeB = bySlug.get(edge.target)?.type;
      if (typeA !== typeB) {
        reasons.push("cross_type");
      }
      const [low, high] = [graph.degree(edge.source), graph.degree(edge.target)].sort(
        (x, y) => x - y,
      );
      if ((low ?? 0) <= 2 && (high ?? 0) >= hubDegree) {
        reasons.push("peripheral_hub");
      }
      return {
        source: edge.source,
        target: edge.target,
        score: round(edge.weight * (1 + reasons.length / 2)),
        reasons,
      };
    })
    .filter((item) => item.reasons.includes("cross_community") && item.reasons.length > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, SURPRISING_MAX);

  const bridges = nodes
    .map((node) => ({
      slug: node.slug,
      communities: new Set(graph.neighbors(node.slug).map((slug) => communityOf.get(slug))).size,
    }))
    .filter((item) => item.communities >= BRIDGE_MIN_COMMUNITIES)
    .sort((x, y) => y.communities - x.communities);

  return {
    nodes,
    edges,
    communities,
    insights: {
      surprising,
      isolated: nodes.filter((node) => node.degree <= ISOLATED_MAX_DEGREE).map((node) => node.slug),
      bridges,
      sparseCommunities: communities
        .filter((item) => item.size >= SPARSE_MIN_SIZE && item.cohesion < SPARSE_COHESION)
        .map((item) => item.id),
    },
  };
}

// --- Loading, with a small cache invalidated by any change to pages, links or embeddings ----

const cache = new Map<string, { key: string; graph: WikiGraph }>();

async function cacheKey(db: Db, officeId: string) {
  const [row] = await db.execute<{ key: string }>(sql`
    select concat_ws(':',
      (select count(*) from ${wikiPages} where ${wikiPages.officeId} = ${officeId}),
      (select max(${wikiPages.updatedAt}) from ${wikiPages} where ${wikiPages.officeId} = ${officeId}),
      (select count(*) from ${wikiEmbeddings} e join ${wikiPages} p on p.id = e.page_id where p.office_id = ${officeId}),
      (select max(e.updated_at) from ${wikiEmbeddings} e join ${wikiPages} p on p.id = e.page_id where p.office_id = ${officeId})
    ) as key`);
  return row?.key ?? "";
}

export async function getWikiGraph(db: Db, officeId: string): Promise<WikiGraph> {
  const key = await cacheKey(db, officeId);
  const cached = cache.get(officeId);
  if (cached?.key === key) {
    return cached.graph;
  }
  const [pages, links, semantic] = await Promise.all([
    db
      .select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        type: wikiPages.type,
        section: wikiPages.section,
        sources: wikiPages.sources,
      })
      .from(wikiPages)
      .where(eq(wikiPages.officeId, officeId)),
    db
      .select({ from: wikiPages.slug, to: wikiLinks.targetSlug })
      .from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiLinks.pageId, wikiPages.id))
      .where(eq(wikiPages.officeId, officeId)),
    semanticNeighbors(db, officeId),
  ]);
  const graph = computeGraph({ pages, links, semantic });
  cache.set(officeId, { key, graph });
  return graph;
}

export async function relatedPages(
  db: Db,
  officeId: string,
  slug: string,
  limit = 8,
): Promise<WikiRelatedPage[]> {
  const graph = await getWikiGraph(db, officeId);
  const nodes = new Map(graph.nodes.map((node) => [node.slug, node]));
  return graph.edges
    .filter((edge) => edge.source === slug || edge.target === slug)
    .slice(0, limit)
    .flatMap((edge) => {
      const other = nodes.get(edge.source === slug ? edge.target : edge.source);
      return other
        ? [
            {
              slug: other.slug,
              title: other.title,
              type: other.type,
              score: edge.weight,
              signals: edge.signals,
            },
          ]
        : [];
    });
}

// Spreads the scores of seed pages to their neighbors (two hops, halved at each hop, scaled by
// the edge weight). Existing scores are never lowered.
export function expandScores(graph: WikiGraph, seeds: Map<string, number>, hops = 2) {
  const maxWeight = graph.edges[0]?.weight ?? 1;
  const neighbors = new Map<string, { slug: string; weight: number }[]>();
  for (const edge of graph.edges) {
    for (const [x, y] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      neighbors.set(x, [...(neighbors.get(x) ?? []), { slug: y, weight: edge.weight }]);
    }
  }
  const scores = new Map(seeds);
  let frontier = new Map(seeds);
  for (let hop = 1; hop <= hops; hop++) {
    const next = new Map<string, number>();
    for (const [slug, score] of frontier) {
      for (const neighbor of neighbors.get(slug) ?? []) {
        const spread = score * 0.5 * (neighbor.weight / maxWeight);
        if (spread > (next.get(neighbor.slug) ?? 0)) {
          next.set(neighbor.slug, spread);
        }
      }
    }
    for (const [slug, score] of next) {
      if (score > (scores.get(slug) ?? 0)) {
        scores.set(slug, score);
      }
    }
    frontier = next;
  }
  return scores;
}
