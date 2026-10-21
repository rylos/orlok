import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalEmbedder,
  getLocalEmbedder,
  isLocalEmbeddingAvailable,
  LOCAL_EMBEDDING_MODEL,
  localModelDirectory,
} from "./index";

const available = await isLocalEmbeddingAvailable();

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
const norm = (vector: number[]) => Math.hypot(...vector);

const TONER =
  "Per sostituire il toner della stampante dell'ufficio aprire lo sportello frontale, " +
  "estrarre la cartuccia esaurita e inserire quella nuova fino allo scatto.";
const VPN =
  "Per configurare la VPN aziendale installare il client, importare il profilo di connessione " +
  "e accedere con le credenziali di dominio.";

function longDocument(paragraphs: number) {
  return Array.from(
    { length: paragraphs },
    (_, index) =>
      `Sezione ${index}. ` +
      "La procedura di manutenzione della stampante prevede il controllo periodico del toner, " +
      "la pulizia del rullo e la verifica della coda di stampa sul server. ".repeat(12),
  ).join("\n\n");
}

describe.skipIf(!available)(
  `built-in embedding model (skipped when model files are missing in ${localModelDirectory()}: run pnpm --filter @orlok/server models:fetch)`,
  () => {
    const embedder = createLocalEmbedder({ testHooks: true, onReady: (ms) => (loadMs = ms) });
    let loadMs = 0;

    beforeAll(async () => {
      await embedder.embed(["warm up"], "query");
      console.info(`[embeddings-local] model load: ${loadMs} ms`);
    }, 120_000);

    afterAll(async () => {
      await embedder.close();
    });

    it("returns normalized 384-dimension vectors", async () => {
      const vectors = await embedder.embed(["ciao", "hello world"], "document");
      expect(vectors).toHaveLength(2);
      for (const vector of vectors) {
        expect(vector).toHaveLength(384);
        expect(norm(vector)).toBeCloseTo(1, 4);
      }
      expect(embedder.dimensions).toBe(384);
      expect(embedder.model).toBe(LOCAL_EMBEDDING_MODEL);
    });

    it("ranks passages by meaning, in Italian and across languages", async () => {
      const [toner, vpn] = await embedder.embed([TONER, VPN], "document");
      const [italian, english] = await embedder.embed(
        ["Come sostituisco il toner della stampante?", "printer toner replacement"],
        "query",
      );
      if (!toner || !vpn || !italian || !english) {
        throw new Error("missing vectors");
      }
      expect(cosine(italian, toner)).toBeGreaterThan(cosine(italian, vpn) + 0.05);
      expect(cosine(english, toner)).toBeGreaterThan(cosine(english, vpn) + 0.05);
    });

    it("embeds a long document (more than 3 chunks) into one vector", async () => {
      const text = longDocument(8);
      const started = performance.now();
      const vectors = await embedder.embed([text], "document");
      const elapsed = performance.now() - started;
      expect(vectors).toHaveLength(1);
      expect(norm(vectors[0] ?? [])).toBeCloseTo(1, 4);
      const [short] = await embedder.embed([text.slice(0, 1_000)], "document");
      expect(cosine(vectors[0] ?? [], short ?? [])).toBeGreaterThan(0.8);
      console.info(
        `[embeddings-local] ${text.length} chars (8 chunks) in ${Math.round(elapsed)} ms`,
      );
    }, 120_000);

    it("handles concurrent calls", async () => {
      const texts = [TONER, VPN, "Orari della mensa aziendale", "Richiesta ferie"];
      const sequential: number[][] = [];
      for (const text of texts) {
        const [vector] = await embedder.embed([text], "document");
        sequential.push(vector ?? []);
      }
      const concurrent = await Promise.all(texts.map((text) => embedder.embed([text], "document")));
      concurrent.forEach(([vector], index) => {
        expect(cosine(vector ?? [], sequential[index] ?? [])).toBeGreaterThan(0.9999);
      });
      // Batching with other texts changes the result only marginally (dynamic quantization
      // scales are computed per batch).
      const batched = await embedder.embed(texts, "document");
      batched.forEach((vector, index) => {
        expect(cosine(vector, sequential[index] ?? [])).toBeGreaterThan(0.99);
      });
    });

    it("keeps the event loop free during a large batch", async () => {
      const texts = Array.from({ length: 48 }, (_, index) => `${index} ${longDocument(1)}`);
      let ticks = 0;
      let longestGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const started = performance.now();
      try {
        const vectors = await embedder.embed(texts, "document");
        expect(vectors).toHaveLength(48);
      } finally {
        clearInterval(timer);
      }
      const elapsed = performance.now() - started;
      console.info(
        `[embeddings-local] 48 chunks of ~${longDocument(1).length} chars: ${Math.round(elapsed)} ms ` +
          `(${Math.round(elapsed / 48)} ms/chunk), ${ticks} timer ticks, longest gap ${Math.round(longestGap)} ms`,
      );
      expect(ticks).toBeGreaterThan(elapsed / 10 / 3);
      expect(longestGap).toBeLessThan(250);
    }, 180_000);

    it("honours abort signals", async () => {
      const controller = new AbortController();
      const call = embedder.embed(
        Array.from({ length: 32 }, () => longDocument(1)),
        "document",
        controller.signal,
      );
      controller.abort();
      await expect(call).rejects.toThrow();
      await expect(embedder.embed(["dopo l'annullamento"], "query")).resolves.toHaveLength(1);
      const aborted = AbortSignal.abort();
      await expect(embedder.embed(["subito"], "query", aborted)).rejects.toThrow();
    }, 120_000);

    it("rejects pending calls when the worker crashes and restarts on the next call", async () => {
      const call = embedder.embed(
        Array.from({ length: 32 }, () => longDocument(1)),
        "document",
      );
      embedder.crashForTests();
      await expect(call).rejects.toThrow(/exited/);
      const [vector] = await embedder.embed(["di nuovo operativo"], "query");
      expect(vector).toHaveLength(384);
    }, 120_000);

    it("provides a lazy singleton", async () => {
      const shared = await getLocalEmbedder();
      expect(shared).not.toBeNull();
      expect(await getLocalEmbedder()).toBe(shared);
      const [vector] = (await shared?.embed(["stampante"], "query")) ?? [];
      expect(vector).toHaveLength(384);
      await shared?.close();
    }, 120_000);
  },
);
