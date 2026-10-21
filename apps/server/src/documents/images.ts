import type { OcrResult } from "./ocr";

export type DocumentImage = {
  /** "img-1", "img-2", … for embedded images; "page-3" for rendered scanned pages. */
  id: string;
  kind: "embedded" | "page";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** Encoded image, at most 1600 px on the long side. */
  data: Uint8Array;
  width: number;
  height: number;
  /** "page 3", "slide 2" or "" when the location is unknown. */
  context: string;
  ocrText: string;
  /** Mean word confidence (0-100), or null when nothing was recognized. */
  ocrConfidence: number | null;
};

export type RasterType = "png" | "jpeg" | "webp" | "gif" | "bmp" | "tiff";
export type ImageSize = { width: number; height: number };

/** Decoded images above this size are rejected as possible decompression bombs. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Embedded images smaller than this on either side (icons, bullets, logos) are ignored. */
export const MIN_EMBEDDED_IMAGE_SIDE = 200;
export const MAX_EMBEDDED_IMAGES = 50;
export const MAX_RETURNED_IMAGES = 60;
export const MAX_OUTPUT_SIDE = 1_600;
const JPEG_QUALITY = 82;
const NUL = String.fromCharCode(0);

export const IMAGE_SLOT_SRC_PREFIX = "orlok-image-slot:";

type CanvasModule = typeof import("@napi-rs/canvas");
let canvasModule: Promise<CanvasModule> | undefined;

/** Loads the native canvas lazily so a missing prebuilt binary only disables image features. */
export function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import("@napi-rs/canvas");
  return canvasModule;
}

function ascii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.subarray(start, start + length));
}

export function sniffImageType(data: Uint8Array): RasterType | undefined {
  if (data.length >= 24 && data[0] === 0x89 && ascii(data, 1, 3) === "PNG") return "png";
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 10 && ascii(data, 0, 4) === "GIF8") return "gif";
  if (data.length >= 30 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return "webp";
  }
  if (data.length >= 26 && ascii(data, 0, 2) === "BM") return "bmp";
  const tiffHeader = ascii(data, 0, 4);
  if (data.length >= 16 && (tiffHeader === `II*${NUL}` || tiffHeader === `MM${NUL}*`))
    return "tiff";
  return undefined;
}

function jpegSize(view: DataView): ImageSize | undefined {
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return undefined;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset++;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    } else {
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return undefined;
}

function webpSize(view: DataView): ImageSize | undefined {
  const chunk = String.fromCharCode(
    view.getUint8(12),
    view.getUint8(13),
    view.getUint8(14),
    view.getUint8(15),
  );
  if (chunk === "VP8 ") {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return {
      width: (view.getUint32(24, true) & 0xffffff) + 1,
      height: (view.getUint32(27, true) & 0xffffff) + 1,
    };
  }
  return undefined;
}

function tiffSize(view: DataView): ImageSize | undefined {
  const littleEndian = view.getUint8(0) === 0x49;
  const directory = view.getUint32(4, littleEndian);
  const count = view.getUint16(directory, littleEndian);
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    const tag = view.getUint16(entry, littleEndian);
    if (tag !== 256 && tag !== 257) continue;
    const isShort = view.getUint16(entry + 2, littleEndian) === 3;
    const value = isShort
      ? view.getUint16(entry + 8, littleEndian)
      : view.getUint32(entry + 8, littleEndian);
    if (tag === 256) width = value;
    else height = value;
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Reads dimensions from the header only, so oversized images are rejected before decoding. */
export function readImageSize(data: Uint8Array, type: RasterType): ImageSize | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    let size: ImageSize | undefined;
    switch (type) {
      case "png":
        size = { width: view.getUint32(16), height: view.getUint32(20) };
        break;
      case "gif":
        size = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        break;
      case "bmp":
        size =
          view.getUint32(14, true) === 12
            ? { width: view.getUint16(18, true), height: view.getUint16(20, true) }
            : {
                width: Math.abs(view.getInt32(18, true)),
                height: Math.abs(view.getInt32(22, true)),
              };
        break;
      case "jpeg":
        size = jpegSize(view);
        break;
      case "webp":
        size = webpSize(view);
        break;
      case "tiff":
        size = tiffSize(view);
        break;
    }
    return size && size.width > 0 && size.height > 0 ? size : undefined;
  } catch {
    // Truncated headers read past the end of the buffer.
    return undefined;
  }
}

type EncodedImage = Pick<DocumentImage, "mimeType" | "data" | "width" | "height">;

const PASSTHROUGH_TYPES: Partial<Record<RasterType, DocumentImage["mimeType"]>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

async function encodeImage(
  data: Uint8Array,
  type: RasterType,
  size: ImageSize,
  preferJpeg: boolean,
): Promise<EncodedImage | undefined> {
  const passthrough = PASSTHROUGH_TYPES[type];
  if (passthrough && !preferJpeg && Math.max(size.width, size.height) <= MAX_OUTPUT_SIDE) {
    return { mimeType: passthrough, data, ...size };
  }
  try {
    const { createCanvas, loadImage } = await loadCanvas();
    const image = await loadImage(data);
    const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    const jpeg = preferJpeg || type === "jpeg";
    if (jpeg) {
      // JPEG has no alpha channel; transparent areas would otherwise turn black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    const encoded = jpeg ? await canvas.encode("jpeg", JPEG_QUALITY) : await canvas.encode("png");
    return {
      mimeType: jpeg ? "image/jpeg" : "image/png",
      data: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      width,
      height,
    };
  } catch {
    return undefined;
  }
}

type Candidate = {
  data: Uint8Array;
  type: RasterType;
  size: ImageSize;
  context: string;
};

export type EmbeddedImageUnit = {
  id: string;
  slot: number;
  candidate: Candidate;
  ocr: OcrResult | null;
};

type PageImage = { number: number; image: DocumentImage };

export function slotToken(slot: number): string {
  return `[image-slot:${slot}]`;
}

function imageMarker(id: string): string {
  return `[image:${id}]`;
}

export function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function describeImage(unit: EmbeddedImageUnit): string {
  const text = unit.ocr?.text ?? "";
  return text ? `${imageMarker(unit.id)}\n${blockquote(text)}` : imageMarker(unit.id);
}

/**
 * Collects images found while converting a document. Converters reserve a slot per image in
 * document order and write a slot token into the Markdown; ids are assigned afterwards so that
 * skipped images (too small, unsupported, over the cap) leave no gaps.
 */
export class ImageCollector {
  truncated = false;
  private nextSlot = 0;
  private readonly slotsByKey = new Map<string, number>();
  private readonly candidates = new Map<number, Candidate>();
  private units: EmbeddedImageUnit[] = [];
  private readonly pages: PageImage[] = [];

  /** Reserves a slot synchronously; the same key (e.g. an archive path) reuses its slot. */
  reserve(key?: string): number {
    const existing = key === undefined ? undefined : this.slotsByKey.get(key);
    if (existing !== undefined) return existing;
    const slot = this.nextSlot++;
    if (key !== undefined) this.slotsByKey.set(key, slot);
    return slot;
  }

  fill(slot: number, data: Uint8Array, context: string): void {
    if (this.candidates.has(slot)) return;
    const type = sniffImageType(data);
    const size = type && readImageSize(data, type);
    if (!type || !size) return;
    if (Math.min(size.width, size.height) < MIN_EMBEDDED_IMAGE_SIDE) return;
    if (size.width * size.height > MAX_IMAGE_PIXELS) return;
    this.candidates.set(slot, { data, type, size, context });
  }

  /** Registers an image whose bytes are at hand and returns the token to place in the Markdown. */
  add(data: Uint8Array | undefined, context: string, key?: string): string {
    const slot = this.reserve(key);
    if (data) this.fill(slot, data, context);
    return slotToken(slot);
  }

  /** Numbers the accepted embedded images in document order, keeping the first ones up to the cap. */
  assignIds(): EmbeddedImageUnit[] {
    const accepted = [...this.candidates.entries()].sort(([a], [b]) => a - b);
    if (accepted.length > MAX_EMBEDDED_IMAGES) this.truncated = true;
    this.units = accepted.slice(0, MAX_EMBEDDED_IMAGES).map(([slot, candidate], index) => ({
      id: `img-${index + 1}`,
      slot,
      candidate,
      ocr: null,
    }));
    return this.units;
  }

  /**
   * Replaces slot tokens with `[image:<id>]` plus the OCR text as a blockquote. Images whose
   * position is unknown (or whose token sits inside another block) are described in a final
   * `## Images` section.
   */
  applyToMarkdown(markdown: string): string {
    const bySlot = new Map(this.units.map((unit) => [unit.slot, unit]));
    const described = new Set<number>();
    let result = markdown.replace(/^\[image-slot:(\d+)\]$/gm, (_match, slot: string) => {
      const unit = bySlot.get(Number(slot));
      if (!unit) return "";
      if (described.has(unit.slot)) return imageMarker(unit.id);
      described.add(unit.slot);
      return describeImage(unit);
    });
    result = result.replace(/\[image-slot:(\d+)\]/g, (_match, slot: string) => {
      const unit = bySlot.get(Number(slot));
      return unit ? imageMarker(unit.id) : "";
    });
    const remaining = this.units.filter((unit) => !described.has(unit.slot));
    if (remaining.length > 0) {
      result += `\n\n## Images\n\n${remaining.map(describeImage).join("\n\n")}`;
    }
    return result;
  }

  /** Keeps a rendered or standalone page image, retaining the least legible pages past the cap. */
  async addPage(page: {
    number: number;
    data: Uint8Array;
    type: RasterType;
    size: ImageSize;
    context: string;
    ocr: OcrResult;
    preferJpeg: boolean;
  }): Promise<void> {
    const source = page.ocr.png ? { data: page.ocr.png, type: "png" as const } : page;
    const encoded = await encodeImage(source.data, source.type, page.size, page.preferJpeg);
    if (!encoded) return;
    this.pages.push({
      number: page.number,
      image: {
        id: `page-${page.number}`,
        kind: "page",
        context: page.context,
        ocrText: page.ocr.text,
        ocrConfidence: page.ocr.confidence,
        ...encoded,
      },
    });
    if (this.pages.length > MAX_RETURNED_IMAGES) {
      // Low-confidence pages are the ones worth a vision transcription, so drop the clearest.
      let clearest = 0;
      this.pages.forEach((candidate, index) => {
        const best = this.pages[clearest]?.image.ocrConfidence ?? 0;
        if ((candidate.image.ocrConfidence ?? 0) > best) clearest = index;
      });
      this.pages.splice(clearest, 1);
    }
  }

  /** Encodes the returned images: embedded ones first, then pages, within MAX_RETURNED_IMAGES. */
  async finalize(): Promise<DocumentImage[]> {
    const images: DocumentImage[] = [];
    for (const { id, candidate, ocr } of this.units) {
      const source = ocr?.png
        ? { data: ocr.png, type: "png" as const }
        : { data: candidate.data, type: candidate.type };
      const encoded = await encodeImage(source.data, source.type, candidate.size, false);
      if (!encoded) continue;
      images.push({
        id,
        kind: "embedded",
        context: candidate.context,
        ocrText: ocr?.text ?? "",
        ocrConfidence: ocr?.confidence ?? null,
        ...encoded,
      });
    }
    const pages = [...this.pages]
      .sort((a, b) => (a.image.ocrConfidence ?? 0) - (b.image.ocrConfidence ?? 0))
      .slice(0, Math.max(0, MAX_RETURNED_IMAGES - images.length))
      .sort((a, b) => a.number - b.number);
    return [...images, ...pages.map((page) => page.image)];
  }
}
