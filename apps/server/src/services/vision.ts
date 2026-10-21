import type { Db } from "../db/client";
import type { ModelProviderRow } from "../db/schema";
import type { DocumentImage } from "../documents";
import type { LlmClient, LlmClientFactory } from "../llm";
import { getDocumentSettings } from "./document-settings";
import { connectionFor, findProfileWithProvider } from "./models";
import { redactSecrets } from "./secrets";

export type VisionTarget = {
  client: LlmClient;
  model: string;
  maxOutputTokens: number;
};

// The model chosen by administrators to read images and scanned pages, if any.
export async function resolveVisionTarget(
  db: Db,
  secretKey: Buffer,
  llm: LlmClientFactory,
  // Puts the calls on the ledger and under the spending limits (R-MOD-4).
  wrap: (client: LlmClient, provider: ModelProviderRow) => LlmClient = (client) => client,
): Promise<VisionTarget | null> {
  const { visionProfileId } = await getDocumentSettings(db);
  if (!visionProfileId) {
    return null;
  }
  const row = await findProfileWithProvider(db, visionProfileId);
  if (!row?.provider.enabled) {
    return null;
  }
  return {
    client: wrap(llm(connectionFor(row.provider, secretKey)), row.provider),
    model: row.profile.model,
    maxOutputTokens: row.profile.maxOutputTokens,
  };
}

// Limits per document: every image is a model call.
const MAX_VISION_PAGES = 30;
const MAX_VISION_IMAGES = 40;
const PAGE_OUTPUT_TOKENS = 8_000;
const IMAGE_OUTPUT_TOKENS = 2_000;
const DECORATIVE = "DECORATIVE";

// The OCR text goes to the vision model with the image: credentials are taken out of it first.
function ocrHint(image: DocumentImage) {
  const text = redactSecrets(image.ocrText.trim()).text;
  return text
    ? `\n\nText found by OCR, for reference only (it may contain recognition errors):\n<ocr>\n${text}\n</ocr>`
    : "";
}

function pagePrompt(title: string, image: DocumentImage) {
  return `This is ${image.context || "a page"} of the scanned document "${title}". Transcribe it into Markdown faithfully: headings, lists, and tables as Markdown tables. Keep numbers, codes and names exactly as written. Write [illegible] where something cannot be read, and never guess or add anything. Reply with the transcription only.${ocrHint(image)}`;
}

function imagePrompt(title: string, image: DocumentImage) {
  return `This image comes from the document "${title}"${image.context ? ` (${image.context})` : ""}, which is being filed into an office wiki. Describe factually and concisely what it shows, in the language of the document, and transcribe exactly any readable text, values, table contents or diagram labels. Write [illegible] where something cannot be read, and never guess. If the image is only decorative (logo, icon, background, signature), reply exactly ${DECORATIVE}. Reply with the description only.${ocrHint(image)}`;
}

async function askAboutImage(
  target: VisionTarget,
  image: DocumentImage,
  prompt: string,
  maxOutputTokens: number,
  signal?: AbortSignal,
) {
  let text = "";
  for await (const chunk of target.client.streamChat({
    model: target.model,
    maxOutputTokens: Math.min(target.maxOutputTokens, maxOutputTokens),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mimeType: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    signal,
  })) {
    if (chunk.type === "text") {
      text += chunk.text;
    }
  }
  return text.trim();
}

export type DocumentImagesOutcome = {
  markdown: string;
  described: number;
  failed: number;
};

// Resolves the image and page markers of extracted Markdown. With a vision model, scanned pages
// are transcribed again (lowest OCR confidence first) and images described; otherwise, or when
// a call fails, the OCR text is kept.
export async function applyDocumentImages(
  markdown: string,
  images: DocumentImage[],
  title: string,
  target: VisionTarget | null,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DocumentImagesOutcome> {
  const transcripts = new Map<string, string>();
  const descriptions = new Map<string, string | null>();
  let described = 0;
  let failed = 0;

  if (target) {
    const pages = images
      .filter((image) => image.kind === "page")
      .sort((a, b) => (a.ocrConfidence ?? 0) - (b.ocrConfidence ?? 0))
      .slice(0, MAX_VISION_PAGES);
    const embedded = images
      .filter((image) => image.kind === "embedded")
      .slice(0, MAX_VISION_IMAGES);
    const total = pages.length + embedded.length;
    let done = 0;
    for (const image of [...pages, ...embedded]) {
      try {
        if (image.kind === "page") {
          const text = await askAboutImage(
            target,
            image,
            pagePrompt(title, image),
            PAGE_OUTPUT_TOKENS,
            options.signal,
          );
          if (text) {
            transcripts.set(image.id, text);
          }
        } else {
          const text = await askAboutImage(
            target,
            image,
            imagePrompt(title, image),
            IMAGE_OUTPUT_TOKENS,
            options.signal,
          );
          descriptions.set(image.id, text === DECORATIVE ? null : text || null);
        }
        described++;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        failed++;
      }
      done++;
      options.onProgress?.(done, total);
    }
  }

  const byId = new Map(images.map((image) => [image.id, image]));
  const result = markdown
    .replace(
      /^\[page:(\d+) ocr\]\n([\s\S]*?)\n?\[\/page\]$/gm,
      (_match, page: string, ocr: string) => transcripts.get(`page-${page}`) ?? ocr,
    )
    .replace(
      /^\[image:([\w-]+)\][^\n]*\n?((?:>[^\n]*(?:\n|$))*)/gm,
      (_match, id: string, quote: string) => {
        const image = byId.get(id);
        const label = image?.context ? `Image (${image.context})` : "Image";
        if (descriptions.has(id)) {
          const description = descriptions.get(id);
          return description ? `> **${label}:** ${description.replace(/\n/g, "\n> ")}\n\n` : "";
        }
        return quote.trim() ? `> **${label}, text read with OCR:**\n${quote}\n` : "";
      },
    )
    .replace(/\n{3,}/g, "\n\n");

  return { markdown: result, described, failed };
}
