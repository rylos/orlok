import type Tesseract from "tesseract.js";
import { describe, expect, it } from "vitest";
import { formatRecognition, resolveOcrLanguages } from "./ocr";

type FakeWord = [text: string, confidence: number];

function page(lines: FakeWord[][], confidence = 70): Tesseract.Page {
  const words = lines.map((line) => ({
    words: line.map(([text, wordConfidence]) => ({ text, confidence: wordConfidence })),
  }));
  return { confidence, blocks: [{ paragraphs: [{ lines: words }] }] } as unknown as Tesseract.Page;
}

describe("OCR text formatting", () => {
  it("marks low-confidence words as illegible and collapses consecutive markers", () => {
    const result = formatRecognition(
      page([
        [
          ["Warranty", 95],
          ["smudged", 20],
          ["serial", 31],
          ["2027", 91],
        ],
        [["—", 5]],
      ]),
    );
    expect(result).toEqual({ text: "Warranty [illegible] 2027\n—", confidence: 70 });
  });

  it("collapses markers across lines", () => {
    const result = formatRecognition(page([[["blur", 10]], [["noise", 12]], [["more", 9]]], 11));
    expect(result).toEqual({ text: "[illegible]", confidence: 11 });
  });

  it("treats a few low-confidence specks without legible words as no text", () => {
    expect(formatRecognition(page([[["-", 35]], [["x", 20]]], 30))).toEqual({
      text: "",
      confidence: null,
    });
  });

  it("keeps bundled languages and falls back to the defaults", () => {
    expect(resolveOcrLanguages(["ita", "ita"])).toEqual(["ita"]);
    expect(resolveOcrLanguages(["xyz", "../eng"])).toEqual(["eng", "ita"]);
    expect(resolveOcrLanguages(undefined)).toEqual(["eng", "ita"]);
  });
});
