import { readFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";
import { chunkText, DEFAULT_MAX_CHUNKS, meanNormalized, normalize } from "./chunking";
import type { WorkerData, WorkerRequest, WorkerResponse } from "./protocol";

// Inference thread: tokenizer and ONNX Runtime (WebAssembly backend, so no native binaries)
// live here, keeping the server event loop free. Requests are processed one at a time.

const MAX_TOKENS = 512;
// Special tokens (<s> and </s>) plus the "passage: " prefix, with a small margin.
const CHUNK_TOKENS = MAX_TOKENS - 12;
const BATCH_SIZE = 16;
// Guard against pathological inputs: only this much text of a single input is looked at.
const MAX_INPUT_CHARACTERS = 200_000;
const PREFIXES = { query: "query: ", document: "passage: " } as const;

const port = parentPort;
if (!port) {
  throw new Error("embeddings-local/worker must run in a worker thread");
}
const options = workerData as WorkerData;
const cancelled = new Set<number>();

type Engine = { tokenizer: Tokenizer; session: ort.InferenceSession; dimensions: number };

async function loadEngine(): Promise<Engine> {
  const started = performance.now();
  const directory = options.modelDirectory;
  const [tokenizerJson, tokenizerConfig, config, model] = await Promise.all([
    readFile(path.join(directory, "tokenizer.json"), "utf8"),
    readFile(path.join(directory, "tokenizer_config.json"), "utf8"),
    readFile(path.join(directory, "config.json"), "utf8"),
    readFile(path.join(directory, options.modelFile)),
  ]);
  const tokenizer = new Tokenizer(JSON.parse(tokenizerJson), JSON.parse(tokenizerConfig));
  ort.env.wasm.numThreads = options.threads;
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  const dimensions = Number((JSON.parse(config) as { hidden_size?: number }).hidden_size);
  post({ type: "ready", loadMs: Math.round(performance.now() - started) });
  return { tokenizer, session, dimensions };
}

let engine: Promise<Engine> | null = null;
let queue: Promise<void> = Promise.resolve();

port.on("message", (message: WorkerRequest) => {
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  if (message.type === "crash") {
    if (options.testHooks) {
      process.exit(1);
    }
    return;
  }
  queue = queue.then(() => handle(message));
});

async function handle(message: Extract<WorkerRequest, { type: "embed" }>) {
  const { id } = message;
  try {
    engine ??= loadEngine();
    const loaded = await engine;
    if (cancelled.delete(id)) {
      return;
    }
    const vectors = await embed(loaded, id, message.texts, message.kind);
    if (!vectors) {
      return;
    }
    post({ type: "result", id, dimensions: loaded.dimensions, vectors }, [vectors.buffer]);
  } catch (error) {
    cancelled.delete(id);
    post({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  }
}

type Chunk = { owner: number; ids: number[]; vector?: Float32Array };

async function embed(
  { tokenizer, session, dimensions }: Engine,
  id: number,
  texts: string[],
  kind: "query" | "document",
): Promise<Float32Array<ArrayBuffer> | null> {
  const prefix = PREFIXES[kind];
  const countTokens = (text: string) =>
    tokenizer.encode(text, { add_special_tokens: false }).ids.length;

  const chunks: Chunk[] = [];
  texts.forEach((text, owner) => {
    const input = text.slice(0, MAX_INPUT_CHARACTERS);
    // Questions are short: they are truncated rather than split.
    const pieces =
      kind === "query"
        ? [input.trim()]
        : chunkText(input, {
            maxSize: CHUNK_TOKENS,
            measure: countTokens,
            maxChunks: DEFAULT_MAX_CHUNKS,
          });
    for (const piece of pieces) {
      chunks.push({ owner, ids: encode(tokenizer, `${prefix}${piece}`) });
    }
  });

  // Similar lengths in the same batch waste less work on padding.
  const ordered = [...chunks].sort((a, b) => a.ids.length - b.ids.length);
  for (let start = 0; start < ordered.length; start += BATCH_SIZE) {
    // Let pending "cancel" messages arrive between batches.
    await new Promise((resolve) => setImmediate(resolve));
    if (cancelled.delete(id)) {
      return null;
    }
    const batch = ordered.slice(start, start + BATCH_SIZE);
    const vectors = await runBatch(
      session,
      batch.map((chunk) => chunk.ids),
      dimensions,
    );
    batch.forEach((chunk, position) => {
      chunk.vector = vectors[position];
    });
  }

  const result = new Float32Array(texts.length * dimensions);
  texts.forEach((_, owner) => {
    const own = chunks.flatMap((chunk) =>
      chunk.owner === owner && chunk.vector ? [chunk.vector] : [],
    );
    result.set(meanNormalized(own, dimensions), owner * dimensions);
  });
  return result;
}

function encode(tokenizer: Tokenizer, text: string) {
  const ids = tokenizer.encode(text).ids;
  if (ids.length <= MAX_TOKENS) {
    return ids;
  }
  // Keep the closing special token.
  return [...ids.slice(0, MAX_TOKENS - 1), ...ids.slice(-1)];
}

async function runBatch(session: ort.InferenceSession, batch: number[][], dimensions: number) {
  const rows = batch.length;
  const columns = Math.max(...batch.map((ids) => ids.length));
  const inputIds = new BigInt64Array(rows * columns);
  const attentionMask = new BigInt64Array(rows * columns);
  batch.forEach((ids, row) => {
    ids.forEach((token, column) => {
      inputIds[row * columns + column] = BigInt(token);
      attentionMask[row * columns + column] = 1n;
    });
  });
  const shape = [rows, columns];
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", inputIds, shape),
    attention_mask: new ort.Tensor("int64", attentionMask, shape),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(rows * columns), shape);
  }
  const outputs = await session.run(feeds);
  const hidden = outputs.last_hidden_state ?? outputs[session.outputNames[0] ?? ""];
  if (!hidden) {
    throw new Error("The embedding model returned no hidden state");
  }
  const data = hidden.data as Float32Array;
  const width = hidden.dims[2] ?? dimensions;
  try {
    // Mean pooling over real tokens, then L2 normalization (as the model card requires).
    return batch.map((ids, row) => {
      const vector = new Float32Array(width);
      for (let column = 0; column < ids.length; column++) {
        const offset = (row * columns + column) * width;
        for (let index = 0; index < width; index++) {
          vector[index] = (vector[index] ?? 0) + (data[offset + index] ?? 0);
        }
      }
      for (let index = 0; index < width; index++) {
        vector[index] = (vector[index] ?? 0) / ids.length;
      }
      return normalize(vector);
    });
  } finally {
    for (const tensor of Object.values(outputs)) {
      tensor.dispose();
    }
  }
}

function post(message: WorkerResponse, transfer?: ArrayBuffer[]) {
  port?.postMessage(message, transfer);
}
