// Messages between the server thread and the embedding worker.

export type WorkerData = {
  modelDirectory: string;
  modelFile: string;
  threads: number;
  testHooks: boolean;
};

export type WorkerRequest =
  | { type: "embed"; id: number; texts: string[]; kind: "query" | "document" }
  | { type: "cancel"; id: number }
  // Only honoured when `testHooks` is set: lets tests check crash recovery.
  | { type: "crash" };

export type WorkerResponse =
  | { type: "ready"; loadMs: number }
  | { type: "result"; id: number; dimensions: number; vectors: Float32Array }
  | { type: "error"; id: number; message: string };
