import type { ImageCollector } from "./images";
import type { OcrSession } from "./ocr";

export type ExtractionProgress = { stage: "text" | "ocr"; done: number; total: number };

/** Per-call state shared by the converters that need OCR or collect images. */
export type ExtractionContext = {
  ocr: OcrSession;
  images: ImageCollector;
  signal: AbortSignal | undefined;
  progress: (stage: ExtractionProgress["stage"], done: number, total: number) => void;
};
