import type {
  RunnerJobRequest,
  RunnerJobState,
  RunnerJobStatus,
  RunnerStreamEvent,
} from "@orlok/shared";
import { OutputCollector } from "./output";
import { exitCodeOf, type ManagedProcess } from "./process";
import type { Sandbox } from "./sandbox";
import { MAX_OUTPUT_BYTES } from "./schemas";
import { type ExecutionContext, type ExecutionResult, runSshJob, type SshBinaries } from "./ssh";
import { runWinrmJob, type WinrmBinaries } from "./winrm";

export const MAX_TIMEOUT_SECONDS = 3600;

export type JobManagerOptions = {
  sandbox: Sandbox;
  ssh: SshBinaries;
  winrm: WinrmBinaries;
  maxJobs: number;
  retentionMs?: number;
  killGraceMs?: number;
};

export type JobListener = (event: RunnerStreamEvent) => void;

type Job = {
  request: RunnerJobRequest;
  state: RunnerJobState;
  collector: OutputCollector;
  listeners: Set<JobListener>;
  current: ManagedProcess | null;
  terminatedBy: "stopped" | "timeout" | null;
  killTimer: NodeJS.Timeout | null;
  done: Promise<void>;
  resolveDone: () => void;
};

// Jobs waiting for a free slot are reported as `running` with empty output; `startedAt` is the
// time they were accepted. The timeout counts from the moment the process starts.
export class JobManager {
  readonly #options: Required<JobManagerOptions>;
  readonly #jobs = new Map<string, Job>();
  readonly #queue: Job[] = [];
  #running = 0;

  constructor(options: JobManagerOptions) {
    this.#options = { retentionMs: 60 * 60 * 1000, killGraceMs: 5000, ...options };
  }

  // Returns false when the id is already known.
  submit(request: RunnerJobRequest): boolean {
    if (this.#jobs.has(request.id)) return false;
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const job: Job = {
      request,
      state: {
        id: request.id,
        status: "running",
        exitCode: null,
        output: "",
        truncated: false,
        hostKey: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      collector: new OutputCollector({
        maxBytes: Math.min(request.maxOutputBytes, MAX_OUTPUT_BYTES),
        secrets: request.secrets,
        onText: (data) => {
          for (const listener of job.listeners) listener({ type: "output", data });
        },
      }),
      listeners: new Set(),
      current: null,
      terminatedBy: null,
      killTimer: null,
      done,
      resolveDone,
    };
    this.#jobs.set(request.id, job);
    this.#queue.push(job);
    this.#pump();
    return true;
  }

  get(id: string): RunnerJobState | undefined {
    const job = this.#jobs.get(id);
    return job ? this.#snapshot(job) : undefined;
  }

  // Registers a listener for live events; `replay` is the output streamed before it.
  // Finished jobs register nothing: the caller sends the replay and the end state.
  subscribe(
    id: string,
    listener: JobListener,
  ): { replay: string; state: RunnerJobState; unsubscribe: () => void } | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    const finished = job.state.finishedAt !== null;
    if (!finished) job.listeners.add(listener);
    return {
      replay: finished ? job.state.output : job.collector.streamed(),
      state: this.#snapshot(job),
      unsubscribe: () => job.listeners.delete(listener),
    };
  }

  // Resolves once the job has finished, or after the kill grace period if it will not die.
  async stop(id: string): Promise<RunnerJobState | undefined> {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#terminate(job, "stopped");
    await Promise.race([job.done, delay(this.#options.killGraceMs + 3000)]);
    return this.#snapshot(job);
  }

  async shutdown() {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) this.#terminate(job, "stopped");
    await Promise.all(jobs.map((job) => job.done));
  }

  #snapshot(job: Job): RunnerJobState {
    if (job.state.finishedAt !== null) return { ...job.state };
    return { ...job.state, output: job.collector.value(), truncated: job.collector.truncated };
  }

  #pump() {
    while (this.#running < this.#options.maxJobs && this.#queue.length > 0) {
      const job = this.#queue.shift() as Job;
      this.#running++;
      void this.#run(job).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }

  async #run(job: Job) {
    const { request } = job;
    const timeoutSeconds = Math.min(request.timeoutSeconds, MAX_TIMEOUT_SECONDS);
    const timeout = setTimeout(() => this.#terminate(job, "timeout"), timeoutSeconds * 1000);
    let result: ExecutionResult;
    try {
      const ctx = this.#context(job);
      result =
        request.target.kind === "local"
          ? await this.#runLocal(ctx, request.command)
          : request.target.kind === "winrm"
            ? await runWinrmJob(ctx, this.#options.winrm, request.target, request.command)
            : await runSshJob(ctx, request.target, request.command);
    } catch (error) {
      job.collector.writeText(`Runner error: ${(error as Error).message}\n`);
      result = { exitCode: null, error: "spawn_failed", hostKey: null };
    } finally {
      clearTimeout(timeout);
    }
    this.#finish(job, result);
  }

  async #runLocal(ctx: ExecutionContext, command: string): Promise<ExecutionResult> {
    const proc = this.#options.sandbox.spawn({
      command: ["/bin/sh", "-c", command],
      cpuLimit: true,
    });
    try {
      const { info } = await ctx.run(proc);
      if (info.error) {
        ctx.note(`The command could not be started: ${info.error.message}\n`);
        return { exitCode: null, error: "spawn_failed", hostKey: null };
      }
      return { exitCode: exitCodeOf(info), error: null, hostKey: null };
    } finally {
      await proc.release();
    }
  }

  #context(job: Job): ExecutionContext {
    return {
      sandbox: this.#options.sandbox,
      ssh: this.#options.ssh,
      run: async (proc, capture = false) => {
        job.current = proc;
        const captured: Buffer[] = [];
        proc.stdout.on("data", (chunk: Buffer) => {
          if (capture) captured.push(chunk);
          else job.collector.write(chunk, "stdout");
        });
        proc.stderr.on("data", (chunk: Buffer) => {
          if (!capture) job.collector.write(chunk, "stderr");
        });
        if (job.terminatedBy) void proc.kill("SIGKILL");
        const info = await proc.closed;
        job.current = null;
        return { info, stdout: Buffer.concat(captured).toString("utf8") };
      },
      note: (text) => job.collector.writeText(text),
      terminated: () => job.terminatedBy !== null,
      output: () => job.collector.value(),
      rawBytes: () => job.collector.rawBytes,
    };
  }

  #terminate(job: Job, reason: "stopped" | "timeout") {
    if (job.state.finishedAt !== null || job.terminatedBy) return;
    job.terminatedBy = reason;
    const queued = this.#queue.indexOf(job);
    if (queued !== -1) {
      this.#queue.splice(queued, 1);
      this.#finish(job, { exitCode: null, error: null, hostKey: null });
      return;
    }
    void job.current?.kill("SIGTERM");
    job.killTimer = setTimeout(() => {
      void job.current?.kill("SIGKILL");
    }, this.#options.killGraceMs);
  }

  #finish(job: Job, result: ExecutionResult) {
    if (job.killTimer) clearTimeout(job.killTimer);
    job.collector.finish();
    const status: RunnerJobStatus = job.terminatedBy ?? (result.error ? "failed" : "done");
    job.state = {
      ...job.state,
      status,
      exitCode: result.exitCode,
      output: job.collector.value(),
      truncated: job.collector.truncated,
      hostKey: result.hostKey,
      error: result.error,
      finishedAt: new Date().toISOString(),
    };
    const end: RunnerStreamEvent = { type: "end", state: { ...job.state } };
    for (const listener of job.listeners) listener(end);
    job.listeners.clear();
    job.resolveDone();
    setTimeout(() => this.#jobs.delete(job.request.id), this.#options.retentionMs).unref();
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
