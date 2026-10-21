import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import manifest from "./models.json" with { type: "json" };
import type { WorkerData, WorkerRequest, WorkerResponse } from "./protocol";

// Built-in embedding engine: multilingual-e5-small (quantized ONNX) running on ONNX Runtime's
// WebAssembly backend in a worker thread. Model files are fetched at build time by
// scripts/fetch-models.mjs; nothing is downloaded at runtime.

export const LOCAL_EMBEDDING_MODEL = "builtin:multilingual-e5-small";
export type LocalEmbeddingKind = "query" | "document";

export type LocalEmbedder = {
  model: string;
  dimensions: number;
  embed(texts: string[], kind: LocalEmbeddingKind, signal?: AbortSignal): Promise<number[][]>;
  close(): Promise<void>;
};

const MODEL_NAME = "multilingual-e5-small";
const MODEL = manifest[MODEL_NAME];
const MODEL_FILE = "onnx/model_quantized.onnx";
const DIMENSIONS = 384;
const SERVER_PACKAGE = "@orlok/server";

// <apps/server>/models, found by walking up to the server package.json, so it resolves the same
// from src/ (tsx, vitest) and from the bundled dist/.
export function localModelDirectory(): string {
  const configured = process.env.ORLOK_MODELS_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  let directory = import.meta.dirname;
  while (true) {
    const packageJson = path.join(directory, "package.json");
    if (existsSync(packageJson) && readPackageName(packageJson) === SERVER_PACKAGE) {
      return path.join(directory, "models");
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return path.resolve("models");
    }
    directory = parent;
  }
}

function readPackageName(file: string) {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name;
  } catch {
    return undefined;
  }
}

function modelPath() {
  return path.join(localModelDirectory(), MODEL_NAME);
}

export async function isLocalEmbeddingAvailable(): Promise<boolean> {
  const directory = modelPath();
  const checks = await Promise.all(
    MODEL.files.map(async (file) => {
      try {
        return (await stat(path.join(directory, file.path))).size === file.size;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

function defaultThreads() {
  const configured = Number.parseInt(process.env.ORLOK_EMBEDDINGS_THREADS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  // Half the cores, leaving room for the server and the database.
  return Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
}

// From src/ the worker is the TypeScript file (loaded through tsx); after bundling it is the
// separate `embeddings-worker.mjs` entry emitted next to the server bundle (tsdown.config.ts).
function workerEntry(): { url: URL; execArgv: string[] } {
  const here = import.meta.dirname;
  const bundled = path.join(here, "embeddings-worker.mjs");
  if (existsSync(bundled)) {
    return { url: pathToFileURL(bundled), execArgv: [] };
  }
  const source = path.join(here, "worker.ts");
  if (existsSync(source)) {
    return { url: pathToFileURL(source), execArgv: ["--import", import.meta.resolve("tsx")] };
  }
  throw new Error(`Embedding worker not found next to ${fileURLToPath(import.meta.url)}`);
}

type Pending = {
  resolve: (vectors: number[][]) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export type LocalEmbedderOptions = {
  modelDirectory?: string;
  threads?: number;
  testHooks?: boolean;
  onReady?: (loadMs: number) => void;
};

// Exported for tests; the server uses getLocalEmbedder().
export function createLocalEmbedder(options: LocalEmbedderOptions = {}) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: unknown) => {
    for (const [id, call] of pending) {
      pending.delete(id);
      call.cleanup();
      call.reject(error);
    }
  };

  const updateRef = () => {
    // An idle worker must not keep the process alive.
    if (pending.size > 0) {
      worker?.ref();
    } else {
      worker?.unref();
    }
  };

  const start = () => {
    const entry = workerEntry();
    const data: WorkerData = {
      modelDirectory: options.modelDirectory ?? modelPath(),
      modelFile: MODEL_FILE,
      threads: options.threads ?? defaultThreads(),
      testHooks: options.testHooks ?? false,
    };
    const created = new Worker(entry.url, {
      workerData: data,
      execArgv: entry.execArgv,
      name: "orlok-embeddings",
    });
    created.on("message", (message: WorkerResponse) => {
      if (message.type === "ready") {
        options.onReady?.(message.loadMs);
        return;
      }
      const call = pending.get(message.id);
      if (!call) {
        return;
      }
      pending.delete(message.id);
      call.cleanup();
      updateRef();
      if (message.type === "error") {
        call.reject(new Error(`Local embedding failed: ${message.message}`));
        return;
      }
      const { dimensions, vectors } = message;
      const result: number[][] = [];
      for (let offset = 0; offset < vectors.length; offset += dimensions) {
        result.push(Array.from(vectors.subarray(offset, offset + dimensions)));
      }
      call.resolve(result);
    });
    const onGone = (error: unknown) => {
      if (worker !== created) {
        return;
      }
      worker = null;
      failAll(error);
    };
    created.on("error", (error) => onGone(new Error(`Embedding worker crashed: ${error.message}`)));
    created.on("exit", (code) => onGone(new Error(`Embedding worker exited with code ${code}`)));
    return created;
  };

  const send = (message: WorkerRequest) => {
    worker ??= start();
    worker.postMessage(message);
  };

  const embedder: LocalEmbedder & { crashForTests(): void } = {
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: DIMENSIONS,
    embed(texts, kind, signal) {
      if (texts.length === 0) {
        return Promise.resolve([]);
      }
      if (signal?.aborted) {
        return Promise.reject(signal.reason);
      }
      const id = nextId++;
      return new Promise<number[][]>((resolve, reject) => {
        const onAbort = () => {
          if (pending.delete(id)) {
            worker?.postMessage({ type: "cancel", id } satisfies WorkerRequest);
            updateRef();
            reject(signal?.reason);
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", onAbort),
        });
        try {
          send({ type: "embed", id, texts, kind });
          updateRef();
        } catch (error) {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      });
    },
    async close() {
      const current = worker;
      worker = null;
      failAll(new Error("Local embedder closed"));
      await current?.terminate();
    },
    crashForTests() {
      worker?.postMessage({ type: "crash" } satisfies WorkerRequest);
    },
  };
  return embedder;
}

let singleton: Promise<LocalEmbedder | null> | null = null;

export function getLocalEmbedder(): Promise<LocalEmbedder | null> {
  singleton ??= isLocalEmbeddingAvailable().then((available) => {
    if (!available) {
      // Checked again next time: the files may be fetched while the server runs.
      singleton = null;
      return null;
    }
    const { crashForTests: _, ...embedder } = createLocalEmbedder();
    return embedder;
  });
  return singleton;
}
