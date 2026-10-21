import type {
  ApiError,
  ConversationSummary,
  EmbeddingOverview,
  EmbeddingTestResult,
  ModelProvider,
  Office,
  WikiGraph,
  WikiRelatedPage,
} from "@orlok/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { wikiEmbeddings } from "../db/schema";
import type { ChatRequest, LlmClientFactory } from "../llm";
import {
  ensureVectorIndex,
  indexPendingEmbeddings,
  resolveEmbedder,
  semanticSearch,
} from "../services/embeddings";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];

// Fake embeddings: one dimension per concept, so synonyms end up close to each other.
const CONCEPTS = [
  ["vpn", "wireguard", "tunnel"],
  ["printer", "printers", "toner", "cartridge", "ink"],
  ["backup", "restore", "snapshot"],
];
function fakeEmbedding(text: string) {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const vector = CONCEPTS.map((group) => words.filter((word) => group.includes(word)).length);
  return vector.some((value) => value > 0) ? [...vector, 0.01] : [0, 0, 0, 1];
}

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async embed({ texts }) {
    return texts.map(fakeEmbedding);
  },
  async *streamChat(request) {
    requests.push(request);
    yield { type: "text", text: "OK" };
    yield { type: "done", stopReason: "end_turn", usage: null };
  },
});

const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function setup() {
  const provider = await call<ModelProvider>("/admin/providers", "POST", {
    name: "Local",
    kind: "openai_compatible",
    baseUrl: "http://models.test/v1",
  });
  const { id: profileId } = (
    await call<{ id: string }>("/admin/profiles", "POST", {
      name: "Chat",
      providerId: provider.body.id,
      model: "chat",
      mode: "ask",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Helpdesk",
    })
  ).body;
  const pages = [
    { title: "VPN", type: "procedure", content: "Connect with WireGuard. See [[firewall]]." },
    { title: "Firewall", type: "entity", content: "Rules of the perimeter." },
    { title: "Toner", type: "procedure", content: "Replace the toner when the printer asks." },
    { title: "Backups", type: "procedure", content: "Nightly snapshot to the NAS." },
  ];
  for (const page of pages) {
    await call(`/offices/${office.id}/wiki/pages`, "POST", page);
  }
  return { provider: provider.body, office, colleague };
}

async function chat(colleagueId: string, content: string) {
  const conversation = await call<ConversationSummary>("/conversations", "POST", { colleagueId });
  const res = await app.request(
    `/api/conversations/${conversation.body.id}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
  return parseSse(await res.text());
}

describe("wiki memory links", () => {
  it("exposes the knowledge graph and related pages", async () => {
    const { office } = await setup();
    const graph = await call<WikiGraph>(`/offices/${office.id}/wiki/graph`);
    expect(graph.body.nodes).toHaveLength(4);
    expect(graph.body.edges).toEqual([
      expect.objectContaining({ source: "firewall", target: "vpn", weight: 3 }),
    ]);
    expect(graph.body.insights.isolated.sort()).toEqual(["backups", "firewall", "toner", "vpn"]);

    const related = await call<WikiRelatedPage[]>(`/offices/${office.id}/wiki/pages/vpn/related`);
    expect(related.body).toEqual([
      {
        slug: "firewall",
        title: "Firewall",
        type: "entity",
        score: 3,
        signals: expect.any(Object),
      },
    ]);
    expect((await call(`/offices/${office.id}/wiki/pages/nope/related`)).res.status).toBe(404);
  });

  it("adds linked pages to the colleague's context through the graph", async () => {
    const { colleague } = await setup();
    const events = await chat(colleague.id, "The VPN does not connect");
    expect(events[0]).toEqual({
      type: "context",
      pages: [
        { slug: "vpn", title: "VPN" },
        { slug: "firewall", title: "Firewall" },
      ],
    });
  });

  it("embeds a long page to its last line", async () => {
    const { provider, office } = await setup();
    // A manual whose only mention of the subject sits at the very end, well past the point where
    // a single embedding request stops.
    const filler = "The office follows the usual procedure for this step. ".repeat(1_200);
    await call(`/offices/${office.id}/wiki/pages`, "POST", {
      title: "Manual",
      type: "procedure",
      content: `${filler}\n\nFinally, restore the snapshot from the backup.`,
    });
    expect(filler.length).toBeGreaterThan(60_000);

    await call("/admin/embeddings", "PUT", {
      mode: "provider",
      providerId: provider.id,
      model: "embed",
    });
    const embedder = await resolveEmbedder({
      db: deps.db,
      llm: fakeLlm,
      localEmbedder: deps.localEmbedder,
      secretKey: deps.config.secretKey,
    });
    if (!embedder) {
      throw new Error("No embedder");
    }
    while ((await indexPendingEmbeddings(deps.db, embedder, 5)) > 0) {
      // Index everything that is waiting.
    }

    // The long page is stored as many pieces, the short ones as one each.
    const rows = await deps.db
      .select({ pageId: wikiEmbeddings.pageId, chunk: wikiEmbeddings.chunk })
      .from(wikiEmbeddings);
    const perPage = new Map<string, number>();
    for (const row of rows) {
      perPage.set(row.pageId, (perPage.get(row.pageId) ?? 0) + 1);
    }
    expect(Math.max(...perPage.values())).toBeGreaterThan(1);
    expect((await call<EmbeddingOverview>("/admin/embeddings")).body.indexedPages).toBe(5);

    const found = await semanticSearch(deps.db, office.id, embedder, "restore", 10);
    expect(found.map((page) => page.slug)).toContain("manual");

    // The pieces are searched through an index built on the dimensions in use.
    expect(await ensureVectorIndex(deps.db)).toBe(4);
    const [index] = await deps.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'wiki_embeddings_vector_idx'`,
    );
    expect(index?.indexdef).toContain("hnsw");
    expect(index?.indexdef).toContain("vector(4)");
    // Still found now that the index answers the search.
    const indexed = await semanticSearch(deps.db, office.id, embedder, "restore", 10);
    expect(indexed.map((page) => page.slug)).toContain("manual");

    // Choosing another model clears what cannot be compared, index included.
    await call("/admin/embeddings", "PUT", { mode: "builtin", providerId: null, model: null });
    expect((await call<EmbeddingOverview>("/admin/embeddings")).body.indexedPages).toBe(0);
    expect(
      await deps.db.execute(
        sql`select indexdef from pg_indexes where indexname = 'wiki_embeddings_vector_idx'`,
      ),
    ).toHaveLength(0);
  });

  it("indexes embeddings and finds pages by meaning", async () => {
    const { provider, office, colleague } = await setup();

    const anthropic = await call<ModelProvider>("/admin/providers", "POST", {
      name: "Claude",
      kind: "anthropic",
      apiKey: "x",
    });
    const refused = await call<ApiError>("/admin/embeddings", "PUT", {
      mode: "provider",
      providerId: anthropic.body.id,
      model: "none",
    });
    expect(refused.res.status).toBe(400);

    const tested = await call<EmbeddingTestResult>("/admin/embeddings/test", "POST", {
      mode: "provider",
      providerId: provider.id,
      model: "embed",
    });
    expect(tested.body).toEqual({ ok: true, dimensions: 4 });

    const saved = await call<EmbeddingOverview>("/admin/embeddings", "PUT", {
      mode: "provider",
      providerId: provider.id,
      model: "embed",
    });
    expect(saved.body).toEqual({
      mode: "provider",
      builtinAvailable: expect.any(Boolean),
      providerId: provider.id,
      model: "embed",
      indexedPages: 0,
      totalPages: 4,
      lastError: null,
    });

    const embedder = await resolveEmbedder({
      db: deps.db,
      llm: fakeLlm,
      localEmbedder: deps.localEmbedder,
      secretKey: deps.config.secretKey,
    });
    expect(embedder).not.toBeNull();
    if (embedder) {
      expect(await indexPendingEmbeddings(deps.db, embedder, 2)).toBe(2);
      await indexPendingEmbeddings(deps.db, embedder, 10);
      expect(await indexPendingEmbeddings(deps.db, embedder, 10)).toBe(0);
    }
    expect((await call<EmbeddingOverview>("/admin/embeddings")).body.indexedPages).toBe(4);

    // "cartridge" appears in no page: only semantic search finds the toner procedure.
    const events = await chat(colleague.id, "cartridge");
    expect(events[0]).toEqual({ type: "context", pages: [{ slug: "toner", title: "Toner" }] });

    // Editing a page makes its embedding stale until indexed again.
    const current = await call<{ revision: number }>(`/offices/${office.id}/wiki/pages/toner`);
    await call(`/offices/${office.id}/wiki/pages/toner`, "PATCH", {
      baseRevision: current.body.revision,
      content: "Replace the ink.",
    });
    expect((await call<EmbeddingOverview>("/admin/embeddings")).body.indexedPages).toBe(3);
  });
});
