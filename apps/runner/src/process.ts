import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  // Set when the process could not be started at all.
  error?: Error;
};

export type KillFn = (signal: "SIGTERM" | "SIGKILL") => Promise<void>;

export type ManagedProcess = {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable | null;
  // Resolves once the leader exited, leftovers were killed and the pipes are closed.
  readonly closed: Promise<ExitInfo>;
  kill(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
};

export type SpawnOptions = {
  env: Record<string, string>;
  stdin?: "ignore" | "pipe";
  cwd?: string;
  // Replaces the default process group kill (e.g. when the process runs as another user).
  kill?: KillFn;
};

// Grace period for pipes held open by processes that escaped the kill.
const PIPE_CLOSE_GRACE_MS = 2000;

// Spawns a process as the leader of its own process group, so the whole tree can be killed.
export function spawnManaged(file: string, args: string[], options: SpawnOptions): ManagedProcess {
  const child: ChildProcess = spawn(file, args, {
    detached: true,
    env: options.env,
    cwd: options.cwd,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;
  const pid = child.pid;

  const kill: KillFn =
    options.kill ??
    (async (signal) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
    });

  const closed = new Promise<ExitInfo>((resolve) => {
    let exit: ExitInfo | undefined;
    let pipesClosed = false;
    let leftoversKilled = false;
    let done = false;
    const finish = (info: ExitInfo) => {
      if (done) return;
      done = true;
      resolve(info);
    };
    child.once("error", (error) => {
      if (exit === undefined) finish({ code: null, signal: null, error });
    });
    child.once("close", () => {
      pipesClosed = true;
      if (exit && leftoversKilled) finish(exit);
    });
    child.once("exit", (code, signal) => {
      const info: ExitInfo = { code, signal };
      exit = info;
      // Background children would otherwise keep running and hold the output pipes open.
      void kill("SIGKILL").finally(() => {
        leftoversKilled = true;
        if (pipesClosed) {
          finish(info);
          return;
        }
        const timer = setTimeout(() => {
          stdout.destroy();
          stderr.destroy();
          finish(info);
        }, PIPE_CLOSE_GRACE_MS);
        timer.unref();
        child.once("close", () => {
          clearTimeout(timer);
          finish(info);
        });
      });
    });
  });

  return { pid, stdout, stderr, stdin: child.stdin, closed, kill };
}

// Conventional shell exit code for a process terminated by a signal.
export function exitCodeOf(info: ExitInfo): number | null {
  if (info.code !== null) return info.code;
  if (info.signal) {
    const numbers: Partial<Record<NodeJS.Signals, number>> = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGKILL: 9,
      SIGSEGV: 11,
      SIGPIPE: 13,
      SIGTERM: 15,
      SIGXCPU: 24,
      SIGXFSZ: 25,
    };
    const number = numbers[info.signal];
    return number === undefined ? null : 128 + number;
  }
  return null;
}

// Runs a helper to completion and captures its output (small outputs only).
export async function runCaptured(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  const proc = spawnManaged(file, args, { env });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const info = await proc.closed;
  return {
    code: info.code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    error: info.error,
  };
}
