import { describe, expect, it } from "vitest";
import {
  meanNormalized,
  remoteChunkCharacters,
  remoteEmbedder,
  remotePieces,
  remoteRequests,
  retryDelayMs,
} from "./embeddings";

// Sending a wiki page to a remote model as one string: the model takes far less text than a page
// holds, and free tiers answer a batch that is too large with 429 instead of embeddings.

describe("splitting texts for a remote model", () => {
  it("uses the limit of the model, not one limit for everything", () => {
    expect(remoteChunkCharacters("gemini-embedding-001")).toBeLessThan(
      remoteChunkCharacters("gemini-embedding-2"),
    );
    expect(remoteChunkCharacters("text-embedding-3-small")).toBeGreaterThan(
      remoteChunkCharacters("gemini-embedding-001"),
    );
    // An unknown model still gets a limit rather than the whole page.
    expect(remoteChunkCharacters("some-new-model")).toBeGreaterThan(0);
  });

  it("splits a long page into pieces that fit, and keeps every piece", () => {
    const paragraph = `${"Il server srvbak ospita i backup notturni. ".repeat(40)}\n\n`;
    const page = paragraph.repeat(12);
    const pieces = remotePieces("gemini-embedding-001", [page], "document");

    expect(pieces.length).toBeGreaterThan(1);
    const limit = remoteChunkCharacters("gemini-embedding-001");
    for (const piece of pieces) {
      expect(piece.text.length).toBeLessThanOrEqual(limit);
      expect(piece.owner).toBe(0);
    }
    // The end of the page is embedded too, which truncation used to drop.
    expect(pieces.at(-1)?.text).toContain("backup notturni");
  });

  it("keeps a question in one piece", () => {
    const pieces = remotePieces("gemini-embedding-001", ["dove sono i backup?"], "query");
    expect(pieces).toHaveLength(1);
  });

  it("groups pieces into requests a free tier accepts", () => {
    const pieces = Array.from({ length: 40 }, () => ({ text: "x".repeat(3_000) }));
    const requests = remoteRequests(pieces);

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(request.length).toBeLessThanOrEqual(16);
      expect(request.reduce((total, piece) => total + piece.text.length, 0)).toBeLessThanOrEqual(
        20_000,
      );
    }
    expect(requests.flat()).toHaveLength(pieces.length);
  });
});

describe("one vector per page", () => {
  it("averages the pieces back to unit length", () => {
    const mean = meanNormalized([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const length = Math.sqrt(mean.reduce((total, value) => total + value * value, 0));
    expect(length).toBeCloseTo(1, 6);
    expect(mean[0]).toBeCloseTo(mean[1] ?? 0, 6);
  });

  it("returns as many vectors as texts, whatever the splitting", async () => {
    const requests: string[][] = [];
    const embedder = remoteEmbedder("gemini-embedding-001", async ({ texts }) => {
      requests.push(texts);
      return texts.map(() => [1, 0, 0]);
    });

    const long = "Paragrafo lungo di prova. ".repeat(500);
    const vectors = await embedder.embed([long, "corta"], "document");

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(3);
    // The long page needed more than one piece, so more texts were sent than pages.
    expect(requests.flat().length).toBeGreaterThan(2);
  });

  it("refuses an answer that does not line up with the request", async () => {
    const embedder = remoteEmbedder("gemini-embedding-001", async () => [[1, 0, 0]]);
    await expect(embedder.embed(["una", "due"], "query")).rejects.toThrow(/2 texts/);
  });
});

describe("waiting as long as the provider asks", () => {
  it("reads Google's RetryInfo detail", () => {
    expect(
      retryDelayMs({
        status: 429,
        error: {
          code: 429,
          message: "You exceeded your current quota",
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34.5s" },
          ],
        },
      }),
    ).toBe(34_500);
  });

  it("falls back to the retry-after header", () => {
    expect(retryDelayMs({ status: 429, headers: new Headers({ "retry-after": "12" }) })).toBe(
      12_000,
    );
    expect(retryDelayMs({ status: 429, headers: { "retry-after": "5" } })).toBe(5_000);
  });

  it("says nothing when the error carries no hint", () => {
    expect(retryDelayMs(new Error("network down"))).toBeUndefined();
    expect(
      retryDelayMs({ status: 429, error: { details: [{ retryDelay: "soon" }] } }),
    ).toBeUndefined();
  });
});
