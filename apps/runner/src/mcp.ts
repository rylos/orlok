import type { Sandbox, SandboxedProcess } from "./sandbox";
import type { McpSessionRequest } from "./schemas";

// MCP stdio bridge: transport only, the server speaks MCP through these events.

export type McpEvent =
  | { event: "message"; data: string }
  | { event: "log"; data: string }
  | { event: "exit"; data: string };

export type McpListener = (event: McpEvent) => void;

export type McpSessionManagerOptions = {
  sandbox: Sandbox;
  maxSessions: number;
  idleMs?: number;
  killGraceMs?: number;
  // How long an exited session stays readable for a late subscriber.
  exitedRetentionMs?: number;
};

// Events are kept while nobody listens; a flooding process loses the oldest ones.
const MAX_BACKLOG_EVENTS = 10_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

type Session = {
  id: string;
  proc: SandboxedProcess;
  listeners: Set<McpListener>;
  backlog: McpEvent[];
  lastActivity: number;
  exited: boolean;
  closed: Promise<void>;
};

export type CreateSessionResult = "created" | "duplicate" | "limit";
export type SendResult = "sent" | "not_found" | "closed";

export class McpSessionManager {
  readonly #options: Required<McpSessionManagerOptions>;
  readonly #sessions = new Map<string, Session>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(options: McpSessionManagerOptions) {
    this.#options = {
      idleMs: 30 * 60 * 1000,
      killGraceMs: 5000,
      exitedRetentionMs: 60 * 1000,
      ...options,
    };
    const interval = Math.max(10, Math.min(60_000, Math.floor(this.#options.idleMs / 2)));
    this.#sweeper = setInterval(() => this.#sweepIdle(), interval);
    this.#sweeper.unref();
  }

  get activeCount() {
    let count = 0;
    for (const session of this.#sessions.values()) if (!session.exited) count++;
    return count;
  }

  create(request: McpSessionRequest): CreateSessionResult {
    if (this.#sessions.has(request.id)) return "duplicate";
    if (this.activeCount >= this.#options.maxSessions) return "limit";
    const proc = this.#options.sandbox.spawn({
      command: [request.command, ...request.args],
      env: request.env,
      stdin: "pipe",
      cpuLimit: false,
    });
    const session: Session = {
      id: request.id,
      proc,
      listeners: new Set(),
      backlog: [],
      lastActivity: Date.now(),
      exited: false,
      closed: Promise.resolve(),
    };
    this.#sessions.set(request.id, session);

    // A process that exits early must not crash the runner with EPIPE.
    proc.stdin?.on("error", () => {});
    splitLines(proc.stdout, (line) => {
      if (isJson(line)) this.#emit(session, { event: "message", data: line });
      else this.#emit(session, { event: "log", data: line });
    });
    splitLines(proc.stderr, (line) => this.#emit(session, { event: "log", data: line }));

    session.closed = proc.closed.then(async (info) => {
      session.exited = true;
      await proc.release();
      const message = info.error ? info.error.message : null;
      if (message) this.#emit(session, { event: "log", data: message });
      this.#emit(session, {
        event: "exit",
        data: JSON.stringify({ code: info.code, signal: info.signal }),
      });
      session.listeners.clear();
      setTimeout(() => {
        if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
      }, this.#options.exitedRetentionMs).unref();
    });
    return "created";
  }

  async send(id: string, message: unknown): Promise<SendResult> {
    const session = this.#sessions.get(id);
    if (!session) return "not_found";
    const stdin = session.proc.stdin;
    if (session.exited || !stdin || stdin.destroyed || !stdin.writable) return "closed";
    session.lastActivity = Date.now();
    const line = `${JSON.stringify(message)}\n`;
    return new Promise((resolve) => {
      stdin.write(line, (error) => resolve(error ? "closed" : "sent"));
    });
  }

  // Replays the events buffered while nobody listened. Returns undefined for unknown sessions.
  subscribe(
    id: string,
    listener: McpListener,
  ): { backlog: McpEvent[]; exited: boolean; unsubscribe: () => void } | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    const backlog = session.backlog;
    session.backlog = [];
    if (!session.exited) session.listeners.add(listener);
    return {
      backlog,
      exited: session.exited,
      unsubscribe: () => session.listeners.delete(listener),
    };
  }

  async delete(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    await this.#kill(session);
    return true;
  }

  async shutdown() {
    clearInterval(this.#sweeper);
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => this.#kill(session)));
  }

  async #kill(session: Session) {
    if (!session.exited) {
      session.proc.stdin?.end();
      void session.proc.kill("SIGTERM");
      const timer = setTimeout(() => {
        void session.proc.kill("SIGKILL");
      }, this.#options.killGraceMs);
      await session.closed;
      clearTimeout(timer);
    }
    await session.closed;
  }

  #emit(session: Session, event: McpEvent) {
    if (session.listeners.size === 0) {
      session.backlog.push(event);
      if (session.backlog.length > MAX_BACKLOG_EVENTS) session.backlog.shift();
      return;
    }
    for (const listener of session.listeners) listener(event);
  }

  #sweepIdle() {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (!session.exited && now - session.lastActivity > this.#options.idleMs) {
        this.#sessions.delete(session.id);
        void this.#kill(session);
      }
    }
  }
}

function isJson(line: string) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function splitLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  stream.on("data", (chunk: Buffer) => {
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline);
      if (!skipping) {
        const line = Buffer.concat([...pending, piece])
          .toString("utf8")
          .replace(/\r$/, "");
        if (line.trim().length > 0) onLine(line);
      }
      pending = [];
      pendingBytes = 0;
      skipping = false;
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length && !skipping) {
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      if (pendingBytes > MAX_LINE_BYTES) {
        onLine(`[line longer than ${MAX_LINE_BYTES} bytes dropped]`);
        pending = [];
        pendingBytes = 0;
        skipping = true;
      }
    }
  });
  stream.on("end", () => {
    if (!skipping && pending.length > 0) {
      const line = Buffer.concat(pending).toString("utf8");
      if (line.trim().length > 0) onLine(line);
    }
  });
}
