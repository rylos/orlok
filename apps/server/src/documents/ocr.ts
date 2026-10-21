import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import Tesseract from "tesseract.js";

/** Maps the server's UI locales to Tesseract language codes. */
export const OCR_LANGUAGES_BY_LOCALE = { en: "eng", it: "ita" } as const;
export const DEFAULT_OCR_LANGUAGES: readonly string[] = ["eng", "ita"];

/** Words recognized below this confidence (0-100) become the illegible marker. */
export const OCR_WORD_CONFIDENCE_THRESHOLD = 60;
export const ILLEGIBLE_MARKER = "[illegible]";

const RECOGNIZE_TIMEOUT_MS = 120_000;
const WORKER_START_TIMEOUT_MS = 60_000;
const LANGUAGE_CODE = /^[a-z]{3}(?:_[a-z]+)*$/;
const WORDLIKE = /[\p{L}\p{N}]/u;

const requireFromHere = createRequire(import.meta.url);

export type OcrResult = {
  text: string;
  confidence: number | null;
  /** PNG rendition of the input, requested for formats the canvas cannot decode (TIFF). */
  png?: Uint8Array | undefined;
};

/** The OCR engine itself failed (not a single image); callers should not blame the file. */
export class OcrEngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OcrEngineError";
  }
}

function languageDataFile(code: string): string | undefined {
  if (!LANGUAGE_CODE.test(code)) return undefined;
  try {
    const manifest = requireFromHere.resolve(`@tesseract.js-data/${code}/package.json`);
    const file = path.join(path.dirname(manifest), "4.0.0_best_int", `${code}.traineddata.gz`);
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the requested languages that have bundled data, falling back to the defaults. */
export function resolveOcrLanguages(requested: readonly string[] | undefined): string[] {
  const available = [...new Set(requested ?? [])].filter((code) => languageDataFile(code));
  return available.length > 0 ? available : [...DEFAULT_OCR_LANGUAGES];
}

function readLink(file: string): string | undefined {
  try {
    return readlinkSync(file);
  } catch {
    return undefined;
  }
}

// tesseract.js loads every language from a single `langPath` directory, while each bundled data
// package has its own folder, so the files are linked side by side in a temporary directory.
// (Passing the data inline is broken in tesseract.js 7.0.0: initialization uses it as a name.)
function linkLanguageData(languages: readonly string[]): string {
  const directory = path.join(os.tmpdir(), `orlok-tessdata-${process.getuid?.() ?? "shared"}`);
  mkdirSync(directory, { recursive: true });
  for (const code of languages) {
    const source = languageDataFile(code);
    if (!source) throw new Error(`No bundled OCR data for language "${code}"`);
    const link = path.join(directory, `${code}.traineddata.gz`);
    if (readLink(link) === source) continue;
    try {
      unlinkSync(link);
    } catch {
      // Nothing to replace yet.
    }
    try {
      symlinkSync(source, link);
    } catch (error) {
      // A concurrent extraction may have created the same link in the meantime.
      if (readLink(link) !== source) throw error;
    }
  }
  return directory;
}

async function createOcrWorker(languages: readonly string[]): Promise<Tesseract.Worker> {
  const langPath = linkLanguageData(languages);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Timed out starting the OCR worker")),
      WORKER_START_TIMEOUT_MS,
    );
    Tesseract.createWorker([...languages], Tesseract.OEM.LSTM_ONLY, {
      langPath,
      // Language data is read from the bundled packages; nothing is cached or downloaded.
      cacheMethod: "none",
      gzip: true,
      // Without a handler tesseract.js rethrows job failures asynchronously and crashes the
      // process. Failed jobs still reject their own promises; startup failures never settle.
      errorHandler: (error: unknown) => fail(new Error(String(error))),
    }).then(
      (worker) => {
        if (settled) {
          void worker.terminate();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(worker);
      },
      (error: unknown) => fail(error),
    );
  });
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("OCR timed out"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Turns Tesseract's word tree into text: low-confidence words become `[illegible]` (consecutive
 * markers collapse) and the unit confidence is Tesseract's mean word confidence.
 */
export function formatRecognition(page: Tesseract.Page): Omit<OcrResult, "png"> {
  let legible = 0;
  let illegible = 0;
  const paragraphs: string[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      const lines: string[] = [];
      for (const line of paragraph.lines) {
        const tokens: string[] = [];
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          if (!WORDLIKE.test(text)) {
            tokens.push(text);
          } else if (word.confidence < OCR_WORD_CONFIDENCE_THRESHOLD) {
            illegible++;
            if (tokens.at(-1) !== ILLEGIBLE_MARKER) tokens.push(ILLEGIBLE_MARKER);
          } else {
            legible++;
            tokens.push(text);
          }
        }
        if (tokens.length > 0) lines.push(tokens.join(" "));
      }
      if (lines.length > 0) paragraphs.push(lines.join("\n"));
    }
  }
  // A couple of low-confidence specks (scanner dust, rules, logos) are noise, not unreadable text.
  if (legible === 0 && illegible < 3) return { text: "", confidence: null };
  const text = paragraphs
    .join("\n\n")
    .replace(/\[illegible\](?:\s+\[illegible\])+/g, ILLEGIBLE_MARKER);
  return { text, confidence: Math.round(page.confidence) };
}

function decodeDataUrl(value: string | null): Uint8Array | undefined {
  const comma = value?.indexOf(",") ?? -1;
  if (!value || comma < 0) return undefined;
  return new Uint8Array(Buffer.from(value.slice(comma + 1), "base64"));
}

/** One lazily started Tesseract worker per extraction; always call `terminate`. */
export class OcrSession {
  /** Number of images or pages recognized successfully. */
  units = 0;
  private worker: Promise<Tesseract.Worker> | undefined;

  constructor(
    private readonly languages: readonly string[],
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * Recognizes one encoded image. Returns null when this image fails; throws only on abort or
   * when the engine cannot start.
   */
  async recognize(
    image: Uint8Array,
    options: { wantPng?: boolean } = {},
  ): Promise<OcrResult | null> {
    this.signal?.throwIfAborted();
    const worker = await this.startWorker();
    try {
      const job = worker.recognize(
        Buffer.from(image.buffer, image.byteOffset, image.byteLength),
        {},
        { text: false, blocks: true, imageColor: options.wantPng === true },
      );
      const { data } = await settleWithin(job, RECOGNIZE_TIMEOUT_MS, this.signal);
      this.units++;
      return {
        ...formatRecognition(data),
        png: options.wantPng ? decodeDataUrl(data.imageColor) : undefined,
      };
    } catch {
      this.signal?.throwIfAborted();
      // A timed-out or crashed worker is not reusable; the next image starts a fresh one.
      await this.terminate();
      return null;
    }
  }

  async terminate(): Promise<void> {
    const pending = this.worker;
    this.worker = undefined;
    if (!pending) return;
    try {
      await (await pending).terminate();
    } catch {
      // The worker never started or has already exited.
    }
  }

  private startWorker(): Promise<Tesseract.Worker> {
    if (!this.worker) {
      const starting = createOcrWorker(this.languages).catch((error: unknown) => {
        throw new OcrEngineError("The OCR engine could not start", { cause: error });
      });
      // Keep the rejection handled here; callers still receive it through the returned promise.
      starting.catch(() => {});
      this.worker = starting;
    }
    return this.worker;
  }
}
