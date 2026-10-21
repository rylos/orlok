import { describe, expect, it } from "vitest";
import {
  chunkText,
  DEFAULT_CHUNK_CHARACTERS,
  meanNormalized,
  normalize,
  pickEvenly,
} from "./chunking";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function paragraph(index: number, sentences: number) {
  return Array.from(
    { length: sentences },
    (_, sentence) => `Paragrafo ${index} frase ${sentence} sulla sostituzione del toner.`,
  ).join(" ");
}

describe("chunkText", () => {
  it("keeps short texts whole", () => {
    expect(chunkText("  Una riga sola.  ", { maxSize: DEFAULT_CHUNK_CHARACTERS })).toEqual([
      "Una riga sola.",
    ]);
    expect(chunkText("", { maxSize: 10 })).toEqual([""]);
  });

  it("splits at paragraph boundaries without losing words", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => paragraph(index, 8));
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, { maxSize: DEFAULT_CHUNK_CHARACTERS });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_CHUNK_CHARACTERS);
    }
    // Paragraphs are packed whole.
    for (const chunk of chunks) {
      for (const part of chunk.split("\n\n")) {
        expect(paragraphs).toContain(part);
      }
    }
    expect(words(chunks.join(" "))).toEqual(words(text));
  });

  it("falls back to sentences, then words, then characters", () => {
    const longParagraph = paragraph(1, 60);
    const bySentence = chunkText(longParagraph, { maxSize: 300 });
    expect(bySentence.length).toBeGreaterThan(1);
    for (const chunk of bySentence) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk.endsWith(".")).toBe(true);
    }

    const blob = "x".repeat(2_500);
    const byCharacters = chunkText(`inizio ${blob} fine`, { maxSize: 1_000 });
    expect(byCharacters.every((chunk) => chunk.length <= 1_000)).toBe(true);
    expect(byCharacters.join("").replaceAll(" ", "")).toBe(`inizio${blob}fine`);
  });

  it("respects a custom measure", () => {
    const text = Array.from({ length: 100 }, (_, index) => `parola${index}`).join(" ");
    const chunks = chunkText(text, { maxSize: 30, measure: (value) => words(value).length });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(words(chunk).length).toBeLessThanOrEqual(30);
    }
    expect(words(chunks.join(" "))).toEqual(words(text));
  });

  it("caps chunks per text, spread across the document", () => {
    const text = Array.from({ length: 40 }, (_, index) => paragraph(index, 3)).join("\n\n");
    const chunks = chunkText(text, { maxSize: 200, maxChunks: 5 });
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toContain("Paragrafo 0 ");
    expect(chunks[4]).toContain("Paragrafo 39 ");
  });
});

describe("vector helpers", () => {
  it("picks evenly including both ends", () => {
    expect(pickEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([0, 4, 8]);
    expect(pickEvenly([1, 2], 5)).toEqual([1, 2]);
    expect(pickEvenly([1, 2, 3], 1)).toEqual([1]);
  });

  it("normalizes and averages", () => {
    expect(Array.from(normalize(new Float32Array([3, 4])))).toEqual([
      expect.closeTo(0.6),
      expect.closeTo(0.8),
    ]);
    const mean = meanNormalized([new Float32Array([1, 0]), new Float32Array([0, 1])], 2);
    expect(Math.hypot(...mean)).toBeCloseTo(1);
    expect(mean[0]).toBeCloseTo(mean[1] ?? 0);
  });
});
