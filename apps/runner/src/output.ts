// Job output pipeline: UTF-8 decoding, ANSI stripping, secret masking and size capping.
// Masking runs after ANSI stripping so escape codes cannot be used to split a secret.

export const SECRET_MARKER = "[secret removed]";
export const TRUNCATION_MARKER = "\n[… output truncated …]\n";

// A long malformed escape sequence is dropped instead of being held forever.
const MAX_ESCAPE_HOLD = 512;

const ESCAPE_SEQUENCE = new RegExp(
  [
    "\\x1b\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC
    "\\x1b[PX^_][^\\x1b]*\\x1b\\\\", // DCS, SOS, PM, APC
    "\\x1b[ -/]*[0-Z\\\\-~]", // two-character and nF escapes
    "\\x9b[0-?]*[ -/]*[@-~]", // 8-bit CSI
  ].join("|"),
  "y",
);

// Removes escape sequences; an unfinished sequence at the end is returned in `rest` so it can
// be completed by the next chunk.
export function stripAnsi(text: string, final = true): { text: string; rest: string } {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const esc = findEscape(text, i);
    if (esc === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, esc);
    ESCAPE_SEQUENCE.lastIndex = esc;
    const match = ESCAPE_SEQUENCE.exec(text);
    if (match) {
      i = esc + match[0].length;
    } else if (!final && text.length - esc < MAX_ESCAPE_HOLD) {
      return { text: out, rest: text.slice(esc) };
    } else {
      i = esc + 1;
    }
  }
  return { text: out, rest: "" };
}

function findEscape(text: string, from: number) {
  const a = text.indexOf("\x1b", from);
  const b = text.indexOf("\x9b", from);
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// Every form of a secret that is masked: the value, its base64 encodings and, for multi-line
// values such as private keys, each long line on its own.
export function secretPatterns(secrets: string[]): string[] {
  const patterns = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    patterns.add(secret);
    const base64 = Buffer.from(secret, "utf8").toString("base64");
    patterns.add(base64);
    patterns.add(base64.replace(/=+$/, ""));
    if (secret.includes("\n")) {
      for (const line of secret.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= 16) patterns.add(trimmed);
      }
    }
  }
  return [...patterns].sort((a, b) => b.length - a.length);
}

export class SecretMasker {
  readonly #patterns: string[];
  #buffer = "";

  constructor(secrets: string[]) {
    this.#patterns = secretPatterns(secrets);
  }

  // Returns the text that can no longer be part of a secret; the rest waits for more data.
  push(text: string): string {
    if (this.#patterns.length === 0) return text;
    this.#buffer += text;
    return this.#drain(false);
  }

  flush(): string {
    return this.#drain(true);
  }

  #drain(final: boolean): string {
    const buffer = this.#buffer;
    const intervals = mergeIntervals(this.#matches(buffer));
    let cut = final ? buffer.length : buffer.length - this.#partialSuffix(buffer);
    // A match crossing the cut could still grow into a longer, overlapping secret.
    for (const [start, end] of intervals) {
      if (start < cut && end > cut) cut = start;
    }
    let out = "";
    let position = 0;
    for (const [start, end] of intervals) {
      if (end > cut) break;
      out += buffer.slice(position, start) + SECRET_MARKER;
      position = end;
    }
    out += buffer.slice(position, cut);
    this.#buffer = buffer.slice(cut);
    return out;
  }

  #matches(buffer: string): [number, number][] {
    const found: [number, number][] = [];
    for (const pattern of this.#patterns) {
      let index = buffer.indexOf(pattern);
      while (index !== -1) {
        found.push([index, index + pattern.length]);
        index = buffer.indexOf(pattern, index + 1);
      }
    }
    return found.sort((a, b) => a[0] - b[0]);
  }

  // Length of the longest buffer suffix that is a proper prefix of some pattern.
  #partialSuffix(buffer: string): number {
    let longest = 0;
    for (const pattern of this.#patterns) {
      const first = pattern[0] as string;
      const from = Math.max(0, buffer.length - pattern.length + 1);
      let index = buffer.indexOf(first, from);
      while (index !== -1 && buffer.length - index > longest) {
        if (pattern.startsWith(buffer.slice(index))) {
          longest = buffer.length - index;
          break;
        }
        index = buffer.indexOf(first, index + 1);
      }
    }
    return longest;
  }
}

function mergeIntervals(sorted: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// Longest prefix of `text` that fits in `maxBytes` of UTF-8 without splitting a character.
export function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

// Keeps the first 80% and the last 20% of `maxBytes`. Live output is released only up to the
// head size, so what was streamed is always a prefix of the final output.
export class OutputCap {
  readonly #maxBytes: number;
  readonly #headBytes: number;
  readonly #tailBytes: number;
  #content = "";
  #bytes = 0;
  #streamedChars = 0;
  #streamedBytes = 0;
  #head = "";
  #tail = "";
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = Math.max(1, Math.floor(maxBytes));
    this.#tailBytes = Math.floor(this.#maxBytes * 0.2);
    this.#headBytes = this.#maxBytes - this.#tailBytes;
  }

  get truncated() {
    return this.#truncated;
  }

  // Appends text and returns the part that may be streamed now.
  append(text: string): string {
    if (text.length === 0) return "";
    if (this.#truncated) {
      this.#tail += text;
      if (this.#tail.length > this.#tailBytes * 2 + 1024) {
        this.#tail = utf8Tail(this.#tail, this.#tailBytes);
      }
      return "";
    }
    this.#content += text;
    this.#bytes += Buffer.byteLength(text, "utf8");
    if (this.#bytes > this.#maxBytes) {
      this.#truncated = true;
      this.#head = utf8Head(this.#content, this.#headBytes);
      this.#tail = utf8Tail(this.#content, this.#tailBytes);
      this.#content = "";
      return this.#head.slice(this.#streamedChars) + TRUNCATION_MARKER;
    }
    if (this.#bytes <= this.#headBytes) {
      const out = this.#content.slice(this.#streamedChars);
      this.#streamedChars = this.#content.length;
      this.#streamedBytes = this.#bytes;
      return out;
    }
    if (this.#streamedBytes >= this.#headBytes) return "";
    const out = utf8Head(
      this.#content.slice(this.#streamedChars),
      this.#headBytes - this.#streamedBytes,
    );
    this.#streamedChars += out.length;
    this.#streamedBytes += Buffer.byteLength(out, "utf8");
    return out;
  }

  // Releases whatever was held back once no more output will come.
  finish(): string {
    if (this.#truncated) return "";
    const out = this.#content.slice(this.#streamedChars);
    this.#streamedChars = this.#content.length;
    this.#streamedBytes = this.#bytes;
    return out;
  }

  // Output streamed so far, for clients that connect late.
  streamed(): string {
    return this.#truncated
      ? this.#head + TRUNCATION_MARKER
      : this.#content.slice(0, this.#streamedChars);
  }

  value(): string {
    return this.#truncated
      ? this.#head + TRUNCATION_MARKER + utf8Tail(this.#tail, this.#tailBytes)
      : this.#content;
  }
}

export type OutputStream = "stdout" | "stderr";

// Combines stdout and stderr in arrival order and emits masked, capped text.
export class OutputCollector {
  readonly #decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  readonly #masker: SecretMasker;
  readonly #cap: OutputCap;
  readonly #onText: (text: string) => void;
  #escapeRest = "";
  #rawBytes = 0;
  #finished = false;

  constructor(options: {
    maxBytes: number;
    secrets: string[];
    onText?: (text: string) => void;
  }) {
    this.#masker = new SecretMasker(options.secrets);
    this.#cap = new OutputCap(options.maxBytes);
    this.#onText = options.onText ?? (() => {});
  }

  get truncated() {
    return this.#cap.truncated;
  }

  // Bytes received from processes, before any processing.
  get rawBytes() {
    return this.#rawBytes;
  }

  write(chunk: Buffer, stream: OutputStream) {
    if (this.#finished) return;
    this.#rawBytes += chunk.length;
    this.#process(this.#decoders[stream].decode(chunk, { stream: true }), false);
  }

  // Runner-generated text (e.g. why an SSH connection could not start).
  writeText(text: string) {
    if (this.#finished) return;
    this.#process(text, false);
  }

  finish() {
    if (this.#finished) return;
    const pending =
      this.#decoders.stdout.decode() + this.#decoders.stderr.decode() + this.#escapeRest;
    this.#escapeRest = "";
    this.#emit(this.#cap.append(this.#masker.push(stripAnsi(pending, true).text)));
    this.#emit(this.#cap.append(this.#masker.flush()));
    this.#emit(this.#cap.finish());
    this.#finished = true;
  }

  streamed() {
    return this.#cap.streamed();
  }

  value() {
    return this.#cap.value();
  }

  #process(text: string, final: boolean) {
    const stripped = stripAnsi(this.#escapeRest + text, final);
    this.#escapeRest = stripped.rest;
    this.#emit(this.#cap.append(this.#masker.push(stripped.text)));
  }

  #emit(text: string) {
    if (text.length > 0) this.#onText(text);
  }
}
