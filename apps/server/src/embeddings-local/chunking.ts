// Splits long texts into pieces that fit the embedding model, preferring natural boundaries:
// paragraphs first, then lines, sentences, words and, as a last resort, characters.

export type MeasureText = (text: string) => number;

export type ChunkOptions = {
  // Largest size of a chunk, in the units returned by `measure`.
  maxSize: number;
  // Characters by default; the worker passes a token counter.
  measure?: MeasureText;
  // Upper bound on chunks per text; extra chunks are dropped evenly, keeping the first one.
  maxChunks?: number;
};

export const DEFAULT_CHUNK_CHARACTERS = 1_500;
export const DEFAULT_MAX_CHUNKS = 16;

const characterLength: MeasureText = (text) => text.length;

type Level = { split: (text: string) => string[]; separator: string };

const LEVELS: Level[] = [
  { split: (text) => text.split(/\n[ \t]*\n\s*/), separator: "\n\n" },
  { split: (text) => text.split(/\n/), separator: "\n" },
  { split: (text) => text.split(/(?<=[.!?…;:])\s+/u), separator: " " },
  { split: (text) => text.split(/\s+/), separator: " " },
];

export function chunkText(text: string, options: ChunkOptions): string[] {
  const measure = options.measure ?? characterLength;
  const maxSize = Math.max(1, Math.floor(options.maxSize));
  const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? DEFAULT_MAX_CHUNKS));
  const trimmed = text.trim();
  if (!trimmed || measure(trimmed) <= maxSize) {
    return [trimmed];
  }
  // Joining pieces costs their separator in characters; a tokenizer usually absorbs whitespace,
  // so one unit is a safe allowance there.
  const separatorSize = options.measure ? () => 1 : (separator: string) => separator.length;
  const chunks = splitAtLevel(trimmed, 0, maxSize, measure, separatorSize).filter(
    (chunk) => chunk.length > 0,
  );
  return pickEvenly(chunks, maxChunks);
}

function splitAtLevel(
  text: string,
  level: number,
  maxSize: number,
  measure: MeasureText,
  separatorCost: (separator: string) => number,
): string[] {
  const current = LEVELS[level];
  if (!current) {
    return splitCharacters(text, maxSize, measure);
  }
  const pieces = current.split(text).map((piece) => piece.trim());
  const separatorSize = separatorCost(current.separator);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferSize = 0;

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer.join(current.separator));
    }
    buffer = [];
    bufferSize = 0;
  };

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }
    const size = measure(piece);
    if (size > maxSize) {
      flush();
      chunks.push(...splitAtLevel(piece, level + 1, maxSize, measure, separatorCost));
      continue;
    }
    const extra = buffer.length > 0 ? size + separatorSize : size;
    if (bufferSize + extra > maxSize) {
      flush();
      buffer.push(piece);
      bufferSize = size;
    } else {
      buffer.push(piece);
      bufferSize += extra;
    }
  }
  flush();
  return chunks;
}

// A single "word" longer than a chunk (a URL, a base64 blob): cut it by characters, shrinking the
// slice until it fits when sizes are measured in tokens.
function splitCharacters(text: string, maxSize: number, measure: MeasureText) {
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    let length = Math.min(rest.length, maxSize);
    while (length > 1 && measure(rest.slice(0, length)) > maxSize) {
      length = Math.max(1, Math.floor(length * 0.8));
    }
    chunks.push(rest.slice(0, length));
    rest = rest.slice(length);
  }
  return chunks;
}

export function pickEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) {
    return items;
  }
  if (limit === 1) {
    return items.slice(0, 1);
  }
  const step = (items.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * step)] as T);
}

export function meanNormalized(vectors: Float32Array[], dimensions: number): Float32Array {
  const mean = new Float32Array(dimensions);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index++) {
      mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0);
    }
  }
  return normalize(mean);
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index++) {
      vector[index] = (vector[index] ?? 0) / norm;
    }
  }
  return vector;
}
