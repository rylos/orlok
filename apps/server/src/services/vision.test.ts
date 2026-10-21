import { describe, expect, it } from "vitest";
import type { DocumentImage } from "../documents";
import type { ChatRequest, LlmClient } from "../llm";
import { applyDocumentImages, type VisionTarget } from "./vision";

function image(
  id: string,
  kind: DocumentImage["kind"],
  context: string,
  ocrText: string,
  ocrConfidence: number | null,
): DocumentImage {
  return {
    id,
    kind,
    mimeType: "image/png",
    data: new Uint8Array([1, 2, 3]),
    width: 400,
    height: 300,
    context,
    ocrText,
    ocrConfidence,
  };
}

const markdown = [
  "# Manual",
  "",
  "[page:1 ocr]",
  "Hel1o w0rld",
  "[/page]",
  "",
  "[image:img-1]",
  "> PORT 51820",
  "",
  "[image:img-2]",
  "",
  "End",
].join("\n");

const images = [
  image("page-1", "page", "page 1", "Hel1o w0rld", 41),
  image("img-1", "embedded", "page 2", "PORT 51820", 88),
  image("img-2", "embedded", "page 2", "", null),
];

describe("applyDocumentImages", () => {
  it("keeps OCR text and removes markers without a vision model", async () => {
    const outcome = await applyDocumentImages(markdown, images, "Manual", null);
    expect(outcome.markdown).toBe(
      "# Manual\n\nHel1o w0rld\n\n> **Image (page 2), text read with OCR:**\n> PORT 51820\n\nEnd",
    );
    expect(outcome.described).toBe(0);
  });

  it("uses the vision model for pages and images and drops decorative ones", async () => {
    const requests: ChatRequest[] = [];
    const answers = ["# Hello world", "Firewall diagram: WAN to WG0, port 51820", "DECORATIVE"];
    const client: LlmClient = {
      async listModels() {
        return [];
      },
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text", text: answers[requests.length - 1] ?? "" };
        yield { type: "done", stopReason: "end_turn", usage: null };
      },
    };
    const target: VisionTarget = { client, model: "vision", maxOutputTokens: 4_000 };

    const outcome = await applyDocumentImages(markdown, images, "Manual", target);
    expect(outcome).toMatchObject({ described: 3, failed: 0 });
    expect(outcome.markdown).toBe(
      "# Manual\n\n# Hello world\n\n> **Image (page 2):** Firewall diagram: WAN to WG0, port 51820\n\nEnd",
    );
    const first = requests[0]?.messages[0];
    expect(
      first?.role === "user" && Array.isArray(first.content) ? first.content[0] : null,
    ).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AQID",
    });
    expect(requests[0]?.maxOutputTokens).toBe(4_000);
  });

  it("falls back to OCR when the model fails", async () => {
    const client: LlmClient = {
      async listModels() {
        return [];
      },
      // biome-ignore lint/correctness/useYield: the model always fails
      async *streamChat() {
        throw new Error("images not supported");
      },
    };
    const outcome = await applyDocumentImages(markdown, images, "Manual", {
      client,
      model: "text-only",
      maxOutputTokens: 1_000,
    });
    expect(outcome).toMatchObject({ described: 0, failed: 3 });
    expect(outcome.markdown).toContain("Hel1o w0rld");
  });
});
