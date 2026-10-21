import { EMBEDDING_MODES, type EmbeddingMode, type EmbeddingSettings } from "@orlok/shared";
import { and, count, countDistinct, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings, wikiEmbeddings, wikiPages } from "../db/schema";
import { LOCAL_EMBEDDING_MODEL } from "../embeddings-local";
import { chunkText } from "../embeddings-local/chunking";
import { describeProviderError } from "../llm";
import type { Deps } from "../types";
import { connectionFor, findProvider } from "./models";

// Semantic memory: embeddings of wiki pages in pgvector, from a provider chosen by
// administrators (OpenAI, OpenAI-compatible servers or Ollama). Everything works without it.

const EMBEDDING_SETTINGS_KEY = "embeddings";
// A page is embedded whole, however long it is: the pieces are stored side by side and a search
// matches the piece that answers it. Only a runaway page is cut, far above any real one.
const EMBEDDING_TEXT_CHARS = 2_000_000;
const EMBEDDING_PIECES_PER_PAGE = 400;
// Pages per round of the worker; each one costs as many embeddings as it has pieces.
const EMBEDDING_BATCH = 8;
// What the built-in model takes at a time (512 tokens), in characters.
const LOCAL_CHUNK_CHARACTERS = 1_500;
// Remote models take far less text than a wiki page: gemini-embedding-001 stops at 2048 tokens and
// the others refuse or silently cut the rest. Pages are split the way the built-in model splits
// them and the pieces averaged, so a long page is embedded whole rather than by its opening.
const REMOTE_TOKEN_LIMITS: [pattern: RegExp, tokens: number][] = [
  [/gemini-embedding-2/i, 8_192],
  [/gemini-embedding|text-embedding-004|text-multilingual-embedding/i, 2_048],
  [/text-embedding-3|text-embedding-ada/i, 8_191],
];
const DEFAULT_REMOTE_TOKENS = 8_192;
// Tokens are shorter than this in English and longer in Italian; erring low only costs a split.
const CHARACTERS_PER_TOKEN = 3.5;
const REMOTE_MAX_CHUNKS = 8;
// One request stays well inside the free tiers' per-minute token budgets.
const REMOTE_REQUEST_CHARACTERS = 20_000;
const REMOTE_REQUEST_PIECES = 16;
// A provider that asks to wait longer than this is treated as down until the next tick.
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const SEMANTIC_NEIGHBORS = 5;
// Pieces read per page asked for: the best pieces often cluster in the same few pages.
const SEMANTIC_PIECES_PER_PAGE = 4;
const SEMANTIC_MIN_SIMILARITY = 0.75;
const SEMANTIC_MIN_RELATIVE_FLOOR = 0.25;
const SEMANTIC_RELATIVE_WINDOW = 0.25;
const SEMANTIC_RANGE_SHARE = 0.35;

export type EmbeddingKind = "query" | "document";

export type Embedder = {
  model: string;
  // Largest piece of a page this model should be given, in characters.
  chunkCharacters: number;
  embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<number[][]>;
};

// Some models expect different prefixes for questions and for the texts they are compared with.
const INPUT_PREFIXES: [pattern: RegExp, prefixes: Record<EmbeddingKind, string>][] = [
  [/\be5\b|multilingual-e5/i, { query: "query: ", document: "passage: " }],
  [/nomic-embed/i, { query: "search_query: ", document: "search_document: " }],
  [
    /qwen3-embedding/i,
    {
      query: "Instruct: Given a question, retrieve the wiki pages that answer it\nQuery: ",
      document: "",
    },
  ],
  [/embeddinggemma/i, { query: "task: search result | query: ", document: "title: none | text: " }],
];

export function withInputPrefix(model: string, kind: EmbeddingKind, text: string) {
  const prefixes = INPUT_PREFIXES.find(([pattern]) => pattern.test(model))?.[1];
  return prefixes ? `${prefixes[kind]}${text}` : text;
}

export async function getEmbeddingSettings(db: Db): Promise<EmbeddingSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, EMBEDDING_SETTINGS_KEY))
    .limit(1);
  const value = row?.value as { mode?: unknown; providerId?: unknown; model?: unknown } | undefined;
  return {
    mode: isEmbeddingMode(value?.mode) ? value.mode : "builtin",
    providerId: typeof value?.providerId === "string" ? value.providerId : null,
    model: typeof value?.model === "string" && value.model ? value.model : null,
  };
}

function isEmbeddingMode(value: unknown): value is EmbeddingMode {
  return typeof value === "string" && (EMBEDDING_MODES as readonly string[]).includes(value);
}

export async function saveEmbeddingSettings(db: Db, value: EmbeddingSettings) {
  await db
    .insert(settings)
    .values({ key: EMBEDDING_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  // Embeddings of another model cannot be compared with the new ones, and their dimensions would
  // keep the vector index from being built: they go now, and the worker fills the wiki again.
  const model = embeddingModelName(value);
  await db.delete(wikiEmbeddings).where(model ? ne(wikiEmbeddings.model, model) : sql`true`);
  await dropVectorIndex(db);
  return value;
}

// pgvector indexes one dimension count at a time, while the column stays free of a dimension so
// the installation can change model. The index is built on the cast the searches use, and
// rebuilt when a model of another size takes over. Above 2000 dimensions only halfvec can be
// indexed, so large models are indexed at half precision: it costs a little recall, not results.
const VECTOR_INDEX = "wiki_embeddings_vector_idx";
const MAX_VECTOR_INDEX_DIMENSIONS = 2_000;

export function vectorCast(dimensions: number) {
  return dimensions > MAX_VECTOR_INDEX_DIMENSIONS
    ? { type: `halfvec(${dimensions})`, ops: "halfvec_cosine_ops" }
    : { type: `vector(${dimensions})`, ops: "vector_cosine_ops" };
}

async function dropVectorIndex(db: Db) {
  await db.execute(sql.raw(`drop index if exists ${VECTOR_INDEX}`));
}

// Cheap enough to call after every indexing round: it only looks at the catalogue.
export async function ensureVectorIndex(db: Db) {
  const [row] = await db.execute<{ dimensions: number | null }>(
    sql`select max(vector_dims(embedding)) as dimensions from ${wikiEmbeddings}`,
  );
  const dimensions = Number(row?.dimensions ?? 0);
  if (!dimensions) {
    return null;
  }
  const cast = vectorCast(dimensions);
  const wanted = `((embedding)::${cast.type})`;
  const [existing] = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where indexname = ${VECTOR_INDEX}`,
  );
  if (existing?.indexdef.includes(wanted)) {
    return dimensions;
  }
  await dropVectorIndex(db);
  await db.execute(
    sql.raw(
      `create index ${VECTOR_INDEX} on wiki_embeddings using hnsw ((embedding::${cast.type}) ${cast.ops})`,
    ),
  );
  return dimensions;
}

export type EmbedderDeps = Pick<Deps, "db" | "llm" | "localEmbedder"> & { secretKey: Buffer };

// Model name the embeddings of the current settings are stored under.
export function embeddingModelName(value: EmbeddingSettings) {
  return value.mode === "builtin"
    ? LOCAL_EMBEDDING_MODEL
    : value.mode === "provider"
      ? value.model
      : null;
}

// How much text one request of this model accepts, in characters.
export function remoteChunkCharacters(model: string) {
  const tokens = REMOTE_TOKEN_LIMITS.find(([pattern]) => pattern.test(model))?.[1];
  return Math.floor((tokens ?? DEFAULT_REMOTE_TOKENS) * CHARACTERS_PER_TOKEN);
}

// Splits every text to the model's limit and remembers which text each piece came from.
export function remotePieces(model: string, texts: string[], kind: EmbeddingKind) {
  const maxSize = remoteChunkCharacters(model);
  const pieces: { owner: number; text: string }[] = [];
  texts.forEach((text, owner) => {
    // A question is short by nature: splitting it would average away what it asks.
    const parts =
      kind === "query"
        ? [text.slice(0, maxSize)]
        : chunkText(text, { maxSize, maxChunks: REMOTE_MAX_CHUNKS });
    for (const part of parts) {
      if (part.trim()) {
        pieces.push({ owner, text: withInputPrefix(model, kind, part) });
      }
    }
  });
  return pieces;
}

// Groups pieces into requests small enough for a free tier's per-minute budget.
export function remoteRequests<T extends { text: string }>(pieces: T[]) {
  const requests: T[][] = [];
  let current: T[] = [];
  let characters = 0;
  for (const piece of pieces) {
    if (
      current.length > 0 &&
      (characters + piece.text.length > REMOTE_REQUEST_CHARACTERS ||
        current.length >= REMOTE_REQUEST_PIECES)
    ) {
      requests.push(current);
      current = [];
      characters = 0;
    }
    current.push(piece);
    characters += piece.text.length;
  }
  if (current.length > 0) {
    requests.push(current);
  }
  return requests;
}

// One vector per text: the pieces of a text are averaged, then brought back to unit length so
// cosine similarity keeps comparing directions.
export function meanNormalized(vectors: number[][]) {
  const first = vectors[0];
  if (!first || vectors.length === 1) {
    return first ?? [];
  }
  const mean = first.map((_, index) => {
    let total = 0;
    for (const vector of vectors) {
      total += vector[index] ?? 0;
    }
    return total / vectors.length;
  });
  const length = Math.sqrt(mean.reduce((total, value) => total + value * value, 0));
  return length > 0 ? mean.map((value) => value / length) : mean;
}

type RemoteEmbed = (request: {
  model: string;
  texts: string[];
  signal?: AbortSignal;
}) => Promise<number[][]>;

export function remoteEmbedder(model: string, embed: RemoteEmbed): Embedder {
  return {
    model,
    chunkCharacters: remoteChunkCharacters(model),
    async embed(texts, kind, signal) {
      const pieces = remotePieces(model, texts, kind);
      const vectors: number[][] = [];
      for (const request of remoteRequests(pieces)) {
        const answer = await embed({ model, texts: request.map((piece) => piece.text), signal });
        if (answer.length !== request.length) {
          throw new Error(
            `The provider returned ${answer.length} embeddings for ${request.length} texts`,
          );
        }
        vectors.push(...answer);
      }
      return texts.map((_, owner) =>
        meanNormalized(vectors.filter((_, index) => pieces[index]?.owner === owner)),
      );
    },
  };
}

export async function embedderFor(
  deps: EmbedderDeps,
  value: EmbeddingSettings,
): Promise<Embedder | null> {
  if (value.mode === "off") {
    return null;
  }
  if (value.mode === "builtin") {
    const local = await deps.localEmbedder();
    return local
      ? {
          model: local.model,
          chunkCharacters: LOCAL_CHUNK_CHARACTERS,
          embed: (texts, kind, signal) => local.embed(texts, kind, signal),
        }
      : null;
  }
  const { providerId, model } = value;
  if (!providerId || !model) {
    return null;
  }
  const provider = await findProvider(deps.db, providerId);
  if (!provider?.enabled) {
    return null;
  }
  const client = deps.llm(connectionFor(provider, deps.secretKey));
  const embed = client.embed?.bind(client);
  if (!embed) {
    return null;
  }
  return remoteEmbedder(model, embed);
}

export async function resolveEmbedder(deps: EmbedderDeps) {
  return embedderFor(deps, await getEmbeddingSettings(deps.db));
}

function toVector(values: number[]) {
  return `[${values.join(",")}]`;
}

export function embeddingText(page: { title: string; section: string | null; content: string }) {
  return `${page.title}\n${page.section ?? ""}\n\n${page.content}`.slice(0, EMBEDDING_TEXT_CHARS);
}

// The pieces a page is embedded as. Each one repeats the title, because a piece taken from the
// middle of a page otherwise says nothing about what the page is.
export function pageChunks(
  page: { title: string; section: string | null; content: string },
  maxCharacters: number,
) {
  const heading = `${page.title}\n${page.section ?? ""}`.trim();
  const body = page.content.slice(0, EMBEDDING_TEXT_CHARS).trim();
  const room = Math.max(200, maxCharacters - heading.length - 2);
  const pieces = body
    ? chunkText(body, { maxSize: room, maxChunks: EMBEDDING_PIECES_PER_PAGE })
    : [];
  return (pieces.length > 0 ? pieces : [""]).map((piece) =>
    piece ? `${heading}\n\n${piece}` : heading,
  );
}

// Embeds pages that have no embedding, an older one or one from another model. Each page becomes
// as many rows as it has pieces, replaced together so a page is never half old and half new.
export async function indexPendingEmbeddings(db: Db, embedder: Embedder, limit = EMBEDDING_BATCH) {
  const pending = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      section: wikiPages.section,
      content: wikiPages.content,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    // The first piece stands for the page: pieces are always written together, from 0.
    .leftJoin(
      wikiEmbeddings,
      and(eq(wikiEmbeddings.pageId, wikiPages.id), eq(wikiEmbeddings.chunk, 0)),
    )
    .where(
      or(
        isNull(wikiEmbeddings.pageId),
        ne(wikiEmbeddings.model, embedder.model),
        // Dates come back with millisecond precision, Postgres keeps microseconds.
        sql`${wikiEmbeddings.pageUpdatedAt} < date_trunc('milliseconds', ${wikiPages.updatedAt})`,
      ),
    )
    .limit(limit);
  if (pending.length === 0) {
    return 0;
  }

  const pieces: { owner: number; text: string }[] = [];
  pending.forEach((page, owner) => {
    for (const text of pageChunks(page, embedder.chunkCharacters)) {
      pieces.push({ owner, text });
    }
  });
  const vectors = await embedder.embed(
    pieces.map((piece) => piece.text),
    "document",
  );

  let stored = 0;
  for (const [owner, page] of pending.entries()) {
    const own = vectors.filter((vector, index) => pieces[index]?.owner === owner && vector?.length);
    if (own.length === 0) {
      continue;
    }
    stored++;
    await db.transaction(async (tx) => {
      await tx.delete(wikiEmbeddings).where(eq(wikiEmbeddings.pageId, page.id));
      await tx.insert(wikiEmbeddings).values(
        own.map((embedding, chunk) => ({
          pageId: page.id,
          chunk,
          model: embedder.model,
          embedding,
          pageUpdatedAt: page.updatedAt,
        })),
      );
    });
  }
  // Fewer than requested (or nothing stored) ends the worker loop until the next tick.
  return stored === limit ? stored : 0;
}

export async function embeddingStatus(db: Db, model: string | null) {
  const [total] = await db.select({ value: count() }).from(wikiPages);
  const [indexed] = model
    ? await db
        .select({ value: countDistinct(wikiEmbeddings.pageId) })
        .from(wikiEmbeddings)
        .innerJoin(wikiPages, eq(wikiEmbeddings.pageId, wikiPages.id))
        .where(
          and(
            eq(wikiEmbeddings.model, model),
            sql`${wikiEmbeddings.pageUpdatedAt} >= date_trunc('milliseconds', ${wikiPages.updatedAt})`,
          ),
        )
    : [{ value: 0 }];
  return { indexedPages: indexed?.value ?? 0, totalPages: total?.value ?? 0 };
}

export async function semanticSearch(
  db: Db,
  officeId: string,
  embedder: Embedder,
  query: string,
  limit = 20,
) {
  const [vector] = await embedder.embed([query], "query");
  if (!vector?.length) {
    return [];
  }
  // A page is as close as its closest piece: one paragraph in the middle of a long page is
  // enough to answer, and averaging it with the rest would hide it.
  // The cast is the one the index is built on, so the nearest pieces come from the index: an
  // aggregate over every row could not use it. Several pieces of one page may answer, so more
  // pieces than pages are taken before grouping.
  const cast = sql.raw(vectorCast(vector.length).type);
  const target = sql`${toVector(vector)}::${cast}`;
  const rows = await db.execute<{ slug: string; title: string; similarity: number }>(sql`
    with nearest as (
      select e.page_id, (e.embedding::${cast}) <=> ${target} as distance
      from ${wikiEmbeddings} e
      join ${wikiPages} p on p.id = e.page_id
      where p.office_id = ${officeId} and e.model = ${embedder.model}
      order by (e.embedding::${cast}) <=> ${target}
      limit ${limit * SEMANTIC_PIECES_PER_PAGE}
    )
    select p.slug, p.title, 1 - min(nearest.distance) as similarity
    from nearest
    join ${wikiPages} p on p.id = nearest.page_id
    group by p.slug, p.title
    order by similarity desc
    limit ${limit}
  `);
  const results = rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    similarity: Number(row.similarity),
  }));
  // Similarity scales differ between models (some keep every text above 0.8): keep the matches in
  // the upper part of the range between the best and the worst candidate.
  const best = results[0]?.similarity ?? 0;
  const worst = results.at(-1)?.similarity ?? 0;
  const threshold = Math.max(
    SEMANTIC_MIN_RELATIVE_FLOOR,
    best - SEMANTIC_RELATIVE_WINDOW,
    results.length >= 5 ? best - (best - worst) * SEMANTIC_RANGE_SHARE : 0,
  );
  return results.filter((row) => row.similarity >= threshold);
}

// Nearest pages of every page of the office (same embedding model only), for the graph. Two pages
// are as near as their nearest pieces.
export async function semanticNeighbors(db: Db, officeId: string) {
  const rows = await db.execute<{ a: string; b: string; similarity: number }>(sql`
    with pairs as (
      select a.slug as a, b.slug as b, max(1 - (ea.embedding <=> eb.embedding)) as similarity
      from ${wikiEmbeddings} ea
      join ${wikiPages} a on a.id = ea.page_id
      join ${wikiEmbeddings} eb on eb.model = ea.model and eb.page_id <> ea.page_id
      join ${wikiPages} b on b.id = eb.page_id and b.office_id = a.office_id
      where a.office_id = ${officeId}
      group by a.slug, b.slug
    ),
    nearest as (
      select a, b, similarity, row_number() over (partition by a order by similarity desc) as rank
      from pairs
    )
    select a, b, similarity from nearest where rank <= ${SEMANTIC_NEIGHBORS}
  `);
  return rows
    .map((row) => ({ a: row.a, b: row.b, similarity: Number(row.similarity) }))
    .filter((row) => row.similarity >= SEMANTIC_MIN_SIMILARITY);
}

// Keeps page embeddings up to date in the background while a provider is configured.
// Google answers a spent quota with a `RetryInfo` detail saying how long to wait; other
// OpenAI-compatible servers use the `retry-after` header. Retrying sooner only spends more quota.
const RETRY_DELAY_SECONDS = /^(\d+)(?:\.(\d{1,9}))?s$/;

export function retryDelayMs(error: unknown): number | undefined {
  const source = error as
    | { error?: { details?: unknown }; headers?: unknown; status?: number }
    | null
    | undefined;
  const details = source?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const delay = (detail as { retryDelay?: unknown } | null)?.retryDelay;
      const match = typeof delay === "string" ? RETRY_DELAY_SECONDS.exec(delay) : null;
      if (match) {
        return Number(match[1]) * 1_000 + Math.ceil(Number(`0.${match[2] ?? 0}`) * 1_000);
      }
    }
  }
  const headers = source?.headers;
  const header =
    headers instanceof Headers
      ? headers.get("retry-after")
      : ((headers as Record<string, string> | undefined)?.["retry-after"] ?? undefined);
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export type EmbeddingFailure = { message: string; at: string };

let lastFailure: EmbeddingFailure | null = null;

// Read by the settings page: a provider that refuses should be visible there, not only in the log.
export function embeddingFailure() {
  return lastFailure;
}

export function startEmbeddingWorker(
  deps: Pick<Deps, "db" | "config" | "llm" | "localEmbedder">,
  intervalMs = 30_000,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick() {
    let wait = intervalMs;
    try {
      const embedder = await resolveEmbedder({ ...deps, secretKey: deps.config.secretKey });
      if (embedder) {
        while (!stopped && (await indexPendingEmbeddings(deps.db, embedder)) > 0) {
          // Keep going while pages are waiting.
        }
      }
      if (embedder) {
        await ensureVectorIndex(deps.db);
      }
      lastFailure = null;
    } catch (error) {
      lastFailure = { message: describeProviderError(error), at: new Date().toISOString() };
      wait = Math.min(Math.max(retryDelayMs(error) ?? intervalMs, intervalMs), MAX_RETRY_DELAY_MS);
      console.error("Embedding worker failed", error);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), wait);
    }
  }

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
