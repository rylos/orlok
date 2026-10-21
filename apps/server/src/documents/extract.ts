import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import type { ExtractionContext, ExtractionProgress } from "./context";
import { htmlTitle, htmlToMarkdown } from "./html";
import {
  IMAGE_SLOT_SRC_PREFIX,
  ImageCollector,
  MAX_IMAGE_PIXELS,
  readImageSize,
  sniffImageType,
} from "./images";
import { type Conversion, normalizeMarkdown } from "./markdown";
import { OcrEngineError, OcrSession, resolveOcrLanguages } from "./ocr";
import {
  collectArchiveImages,
  odpToMarkdown,
  odtToMarkdown,
  ooxmlTitle,
  pptxToMarkdown,
} from "./office";
import { pdfToMarkdown } from "./pdf";
import { rtfToMarkdown } from "./rtf";
import { delimitedToMarkdown, spreadsheetToMarkdown } from "./tabular";

export type { ExtractionProgress } from "./context";
export type { DocumentImage } from "./images";
export { OCR_LANGUAGES_BY_LOCALE } from "./ocr";

import type { DocumentImage } from "./images";

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "html",
  "htm",
  "docx",
  "doc",
  "pdf",
  "xlsx",
  "xlsm",
  "xls",
  "ods",
  "odt",
  "odp",
  "pptx",
  "rtf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "tif",
  "tiff",
] as const;

export type DocumentFormat =
  | "markdown"
  | "text"
  | "json"
  | "xml"
  | "yaml"
  | "csv"
  | "tsv"
  | "html"
  | "docx"
  | "doc"
  | "pdf"
  | "xlsx"
  | "xls"
  | "ods"
  | "odt"
  | "odp"
  | "pptx"
  | "rtf"
  | "image";

export type ExtractedDocument = {
  title: string;
  format: DocumentFormat;
  markdown: string;
  /** True when any content was left out (character cap, table rows/columns, pages, images). */
  truncated: boolean;
  /** Number of images or rendered pages that went through OCR. */
  ocrUnits: number;
  /** Embedded images (in document order) followed by OCR'd pages, at most 60 in total. */
  images: DocumentImage[];
};

export type ExtractDocumentInput = {
  fileName: string;
  mimeType?: string | null;
  data: Uint8Array;
  /** Tesseract language codes; unknown or unbundled ones are ignored. Default ["eng", "ita"]. */
  ocrLanguages?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (progress: ExtractionProgress) => void;
};

export type DocumentExtractionErrorCode = "unsupported_format" | "no_text" | "invalid_file";

export class DocumentExtractionError extends Error {
  readonly code: DocumentExtractionErrorCode;

  constructor(code: DocumentExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentExtractionError";
    this.code = code;
  }
}

export const MAX_DOCUMENT_CHARS = 500_000;

const NUL = String.fromCharCode(0);

const FORMAT_BY_EXTENSION: Record<(typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number], DocumentFormat> =
  {
    md: "markdown",
    markdown: "markdown",
    txt: "text",
    log: "text",
    json: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    csv: "csv",
    tsv: "tsv",
    html: "html",
    htm: "html",
    docx: "docx",
    doc: "doc",
    pdf: "pdf",
    xlsx: "xlsx",
    xlsm: "xlsx",
    xls: "xls",
    ods: "ods",
    odt: "odt",
    odp: "odp",
    pptx: "pptx",
    rtf: "rtf",
    png: "image",
    jpg: "image",
    jpeg: "image",
    webp: "image",
    bmp: "image",
    gif: "image",
    tif: "image",
    tiff: "image",
  };

const FORMAT_BY_MIME_TYPE: Record<string, DocumentFormat> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "text",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/bmp": "image",
  "image/x-ms-bmp": "image",
  "image/gif": "image",
  "image/tiff": "image",
};

// PDF and image extraction report their own page-level progress.
const REPORTS_OWN_PROGRESS: ReadonlySet<DocumentFormat> = new Set(["pdf", "image"]);

const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
];

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function extensionOf(fileName: string): string {
  const name = baseName(fileName);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Format by file extension, falling back to the MIME type; null when unsupported. */
export function detectDocumentFormat(
  fileName: string,
  mimeType?: string | null,
): DocumentFormat | null {
  const extension = extensionOf(fileName);
  if (Object.hasOwn(FORMAT_BY_EXTENSION, extension)) {
    return FORMAT_BY_EXTENSION[extension as keyof typeof FORMAT_BY_EXTENSION];
  }
  const essence = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return Object.hasOwn(FORMAT_BY_MIME_TYPE, essence)
    ? (FORMAT_BY_MIME_TYPE[essence] ?? null)
    : null;
}

function defaultTitle(fileName: string): string {
  const name = baseName(fileName);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim() || "Untitled";
}

function decodeText(data: Uint8Array): string {
  let encoding = "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) encoding = "utf-16le";
  else if (data[0] === 0xfe && data[1] === 0xff) encoding = "utf-16be";
  // TextDecoder already strips a leading byte order mark.
  return new TextDecoder(encoding).decode(data).replaceAll(NUL, "");
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function docxToMarkdown(data: Uint8Array, images: ImageCollector): Promise<Conversion> {
  const result = await mammoth.convertToHtml(
    { buffer: toBuffer(data) },
    {
      styleMap: DOCX_STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        // Mammoth starts image conversions in document order but they finish in any order.
        const slot = images.reserve();
        images.fill(slot, new Uint8Array(await image.read()), "");
        return { src: `${IMAGE_SLOT_SRC_PREFIX}${slot}` };
      }),
    },
  );
  return { markdown: htmlToMarkdown(result.value), title: ooxmlTitle(data) };
}

async function docToMarkdown(data: Uint8Array): Promise<Conversion> {
  const document = await new WordExtractor().extract(toBuffer(data));
  const notes = [document.getFootnotes(), document.getEndnotes()]
    .map((text) => text.trim())
    .filter(Boolean);
  const sections = [document.getBody()];
  if (notes.length > 0) sections.push(`## Notes\n\n${notes.join("\n\n")}`);
  return { markdown: sections.join("\n\n") };
}

async function imageToMarkdown(data: Uint8Array, context: ExtractionContext): Promise<Conversion> {
  const type = sniffImageType(data);
  const size = type && readImageSize(data, type);
  if (!type || !size) throw new Error("Unrecognized or corrupt image data");
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image is larger than ${MAX_IMAGE_PIXELS} pixels`);
  }
  context.progress("text", 1, 1);
  const result = await context.ocr.recognize(data, { wantPng: type === "tiff" });
  context.progress("ocr", 1, 1);
  if (!result?.text) return { markdown: "" };
  await context.images.addPage({
    number: 1,
    data,
    type,
    size,
    context: "",
    ocr: result,
    preferJpeg: false,
  });
  return { markdown: `[page:1 ocr]\n${result.text}\n[/page]` };
}

function withArchiveImages(
  conversion: Conversion,
  data: Uint8Array,
  folder: string,
  images: ImageCollector,
): Conversion {
  try {
    collectArchiveImages(data, folder, images);
  } catch {
    // Images are optional; the sheet data was already read.
  }
  return conversion;
}

function convert(
  format: DocumentFormat,
  data: Uint8Array,
  context: ExtractionContext,
): Conversion | Promise<Conversion> {
  switch (format) {
    case "markdown":
    case "text":
    case "json":
    case "xml":
    case "yaml":
      return { markdown: decodeText(data) };
    case "csv":
      return delimitedToMarkdown(decodeText(data));
    case "tsv":
      return delimitedToMarkdown(decodeText(data), "\t");
    case "html": {
      const html = decodeText(data);
      return { markdown: htmlToMarkdown(html), title: htmlTitle(html) };
    }
    case "docx":
      return docxToMarkdown(data, context.images);
    case "doc":
      return docToMarkdown(data);
    case "pdf":
      return pdfToMarkdown(data, context);
    case "xlsx":
      return withArchiveImages(spreadsheetToMarkdown(data), data, "xl/media/", context.images);
    case "ods":
      return withArchiveImages(spreadsheetToMarkdown(data), data, "Pictures/", context.images);
    case "xls":
      return spreadsheetToMarkdown(data);
    case "odt":
      return odtToMarkdown(data, context.images);
    case "odp":
      return odpToMarkdown(data, context.images);
    case "pptx":
      return pptxToMarkdown(data, context.images);
    case "rtf":
      return rtfToMarkdown(data);
    case "image":
      return imageToMarkdown(data, context);
  }
}

function truncate(markdown: string): { text: string; truncated: boolean } {
  if (markdown.length <= MAX_DOCUMENT_CHARS) return { text: markdown, truncated: false };
  let end = MAX_DOCUMENT_CHARS;
  const last = markdown.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  // Prefer ending on a line break so the last block is not cut mid-word.
  const lineBreak = markdown.lastIndexOf("\n", end);
  if (lineBreak > end - 2_000) end = lineBreak;
  return { text: markdown.slice(0, end).trimEnd(), truncated: true };
}

function noTextMessage(format: DocumentFormat): string {
  if (format === "pdf") return "The PDF has no text layer and OCR recognized no text";
  if (format === "image") return "OCR recognized no text in the image";
  return "The document contains no text";
}

/**
 * Extracts an office document, PDF or image as Markdown for LLM consumption, running OCR on
 * scanned pages and embedded images. The format is chosen by file extension, falling back to
 * the MIME type.
 *
 * Throws DocumentExtractionError for file problems, the signal's reason when aborted and
 * OcrEngineError when the OCR engine or native canvas cannot start.
 */
export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractedDocument> {
  const format = detectDocumentFormat(input.fileName, input.mimeType);
  if (!format) {
    const extension = extensionOf(input.fileName);
    throw new DocumentExtractionError(
      "unsupported_format",
      `Unsupported document type: ${extension ? `.${extension}` : input.mimeType || "unknown"}`,
    );
  }
  const { signal, onProgress } = input;
  signal?.throwIfAborted();

  const ocr = new OcrSession(resolveOcrLanguages(input.ocrLanguages), signal);
  const images = new ImageCollector();
  const context: ExtractionContext = {
    ocr,
    images,
    signal,
    progress: (stage, done, total) => onProgress?.({ stage, done, total }),
  };

  try {
    let conversion: Conversion;
    try {
      conversion = await convert(format, input.data, context);
    } catch (error) {
      // Cancellation and engine failures are not problems with the file.
      if (signal?.aborted || error instanceof OcrEngineError) throw error;
      throw new DocumentExtractionError(
        "invalid_file",
        `Could not read "${baseName(input.fileName)}" as ${format}`,
        { cause: error },
      );
    }
    if (!REPORTS_OWN_PROGRESS.has(format)) context.progress("text", 1, 1);

    const embedded = images.assignIds();
    for (const [index, unit] of embedded.entries()) {
      unit.ocr = await ocr.recognize(unit.candidate.data, {
        wantPng: unit.candidate.type === "tiff",
      });
      context.progress("ocr", index + 1, embedded.length);
    }

    const markdown = normalizeMarkdown(images.applyToMarkdown(conversion.markdown));
    if (!markdown) throw new DocumentExtractionError("no_text", noTextMessage(format));

    const { text, truncated } = truncate(markdown);
    return {
      title: conversion.title?.trim() || defaultTitle(input.fileName),
      format,
      markdown: text,
      truncated: truncated || conversion.truncated === true || images.truncated,
      ocrUnits: ocr.units,
      images: await images.finalize(),
    };
  } finally {
    await ocr.terminate();
  }
}
