import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  definePDFJSModule,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
} from "unpdf";
import type { ExtractionContext } from "./context";
import { loadCanvas, readImageSize } from "./images";
import type { Conversion } from "./markdown";
import { OcrEngineError } from "./ocr";

const MAX_PDF_PAGES = 2_000;
export const MAX_OCR_PAGES = 300;
/** Pages whose text layer has fewer non-space characters than this are OCR candidates. */
export const MIN_TEXT_LAYER_CHARS = 20;
// Text converted to outlines has no text layer but draws many paths.
const MIN_VECTOR_PATHS = 50;
const OCR_DPI = 200;
const MAX_RENDER_SIDE = 5_000;
const MAX_RENDER_PIXELS = 40_000_000;

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfAssets = { standardFontDataUrl: string; cMapUrl: string; wasmUrl: string };

const requireFromHere = createRequire(import.meta.url);
let pdfjsAssets: Promise<PdfAssets> | undefined;

function preparePdfjs(): Promise<PdfAssets> {
  pdfjsAssets ??= (async () => {
    // unpdf's bundled serverless PDF.js cannot rasterize pages or decode JBIG2/JPEG 2000 scans;
    // the official build can. pnpm's strict layout also hides pdfjs-dist from unpdf's own asset
    // lookup, so fonts, CMaps and wasm decoders are passed explicitly.
    await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
    const root = path.dirname(requireFromHere.resolve("pdfjs-dist/package.json"));
    const folder = (name: string) => pathToFileURL(`${path.join(root, name)}${path.sep}`).href;
    return {
      standardFontDataUrl: folder("standard_fonts"),
      cMapUrl: folder("cmaps"),
      wasmUrl: folder("wasm"),
    };
  })();
  return pdfjsAssets;
}

async function renderPage(pdf: PdfDocument, pageNumber: number): Promise<Uint8Array | undefined> {
  const page = await pdf.getPage(pageNumber);
  const { width, height } = page.getViewport({ scale: 1 });
  const scale = Math.min(
    OCR_DPI / 72,
    MAX_RENDER_SIDE / Math.max(width, height),
    Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
  );
  if (!(scale > 0) || !Number.isFinite(scale)) return undefined;
  try {
    await loadCanvas();
  } catch (error) {
    throw new OcrEngineError("The native canvas needed to render PDF pages is unavailable", {
      cause: error,
    });
  }
  try {
    const rendered = await renderPageAsImage(pdf, pageNumber, { canvasImport: loadCanvas, scale });
    return typeof rendered === "string" ? undefined : new Uint8Array(rendered);
  } catch {
    // A page that fails to render keeps whatever text layer it had.
    return undefined;
  }
}

async function ocrPage(
  pdf: PdfDocument,
  pageNumber: number,
  context: ExtractionContext,
): Promise<string> {
  const png = await renderPage(pdf, pageNumber);
  const size = png && readImageSize(png, "png");
  if (!png || !size) return "";
  const result = await context.ocr.recognize(png);
  if (!result?.text) return "";
  await context.images.addPage({
    number: pageNumber,
    data: png,
    type: "png",
    size,
    context: `page ${pageNumber}`,
    ocr: result,
    preferJpeg: true,
  });
  return result.text;
}

/**
 * Extracts text per page. Pages without a usable text layer that paint images or many paths
 * are rendered at ~200 DPI and OCR'd; their text is wrapped in `[page:<n> ocr]` … `[/page]`.
 */
export async function pdfToMarkdown(
  data: Uint8Array,
  context: ExtractionContext,
): Promise<Conversion> {
  const assets = await preparePdfjs();
  // pdf.js detaches the buffer it receives, so it gets a copy.
  const pdf = await getDocumentProxy(data.slice(), {
    ...assets,
    cMapPacked: true,
    disableFontFace: true,
    verbosity: 0,
    maxImageSize: 16_777_216,
  });
  try {
    const { OPS } = await getResolvedPDFJS();
    const imageOperators = new Set<number>([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintSolidColorImageMask,
    ]);

    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    const scanned: number[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      context.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.hasEOL ? `${item.str}\n` : item.str;
      }
      pages.push(text.trim());
      if (text.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) {
        const { fnArray } = await page.getOperatorList();
        let paths = 0;
        let paintsImage = false;
        for (const operator of fnArray) {
          if (imageOperators.has(operator)) paintsImage = true;
          else if (operator === OPS.constructPath) paths++;
        }
        if (paintsImage || paths >= MIN_VECTOR_PATHS) scanned.push(pageNumber);
      }
      page.cleanup();
      context.progress("text", pageNumber, pageCount);
    }

    const ocrPages = scanned.slice(0, MAX_OCR_PAGES);
    for (const [index, pageNumber] of ocrPages.entries()) {
      const text = await ocrPage(pdf, pageNumber, context);
      if (text) pages[pageNumber - 1] = `[page:${pageNumber} ocr]\n${text}\n[/page]`;
      context.progress("ocr", index + 1, ocrPages.length);
    }

    const { info } = await getMeta(pdf);
    const title: unknown = info.Title;
    return {
      markdown: pages.filter(Boolean).join("\n\n"),
      // Some generators stamp a literal "untitled" instead of leaving the field empty.
      title:
        typeof title === "string" && title.trim().toLowerCase() !== "untitled"
          ? title.trim()
          : undefined,
      truncated: pdf.numPages > pageCount || scanned.length > ocrPages.length,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
