import type {
  RunnerHealth,
  RunnerJobRequest,
  RunnerJobState,
  RunnerMcpSession,
  RunnerStreamEvent,
} from "@orlok/shared";

// Client of the internal runner service (apps/runner) that executes colleague commands.

export interface RunnerClient {
  health(): Promise<RunnerHealth>;
  start(request: RunnerJobRequest): Promise<void>;
  get(id: string): Promise<RunnerJobState>;
  stop(id: string): Promise<void>;
  // Resolves when the job ends or when timeoutMs passes (the job may still be running).
  // MCP stdio bridge: a process in the runner speaking JSON-RPC lines.
  mcpOpen(session: RunnerMcpSession): Promise<void>;
  mcpSend(id: string, message: unknown): Promise<void>;
  mcpEvents(
    id: string,
    handlers: { onMessage: (message: unknown) => void; onExit: () => void },
    signal: AbortSignal,
  ): Promise<void>;
  mcpClose(id: string): Promise<void>;
  wait(
    id: string,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      onOutput?: (data: string) => void;
      // Called with each state read while the job still runs (polling only), output so far included.
      onProgress?: (state: RunnerJobState) => Promise<void>;
    },
  ): Promise<RunnerJobState>;
}

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

const POLL_MS = 1_000;

export function createRunnerClient({ url, token }: { url: string; token: string }): RunnerClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch (error) {
      throw new RunnerError(
        `Runner unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) {
      throw new RunnerError(`Runner answered ${res.status}: ${await res.text()}`, res.status);
    }
    return (res.status === 202 || res.status === 204 ? undefined : await res.json()) as T;
  }

  const client: RunnerClient = {
    health: () => request<RunnerHealth>("/v1/health"),
    async start(job) {
      await request<{ id: string }>("/v1/jobs", { method: "POST", body: JSON.stringify(job) });
    },
    get: (id) => request<RunnerJobState>(`/v1/jobs/${encodeURIComponent(id)}`),
    async stop(id) {
      await request(`/v1/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" });
    },
    async mcpOpen(session) {
      await request("/v1/mcp/sessions", { method: "POST", body: JSON.stringify(session) });
    },
    async mcpSend(id, message) {
      await request(`/v1/mcp/sessions/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify(message),
      });
    },
    async mcpEvents(id, handlers, signal) {
      const res = await fetch(`${url}/v1/mcp/sessions/${encodeURIComponent(id)}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new RunnerError(`Runner MCP events answered ${res.status}`, res.status);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const lines = frame.split("\n");
            const event = lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (event === "exit") {
              handlers.onExit();
              return;
            }
            if (!event && data) {
              handlers.onMessage(JSON.parse(data));
            }
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
      handlers.onExit();
    },
    async mcpClose(id) {
      await request(`/v1/mcp/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async wait(id, { timeoutMs, signal, onOutput, onProgress }) {
      const deadline = Date.now() + timeoutMs;
      if (onOutput) {
        return streamUntilEnd(id, deadline, signal, onOutput);
      }
      for (;;) {
        const state = await client.get(id);
        if (state.status !== "running" || Date.now() >= deadline || signal?.aborted) {
          return state;
        }
        await onProgress?.(state);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
  };

  async function streamUntilEnd(
    id: string,
    deadline: number,
    signal: AbortSignal | undefined,
    onOutput: (data: string) => void,
  ): Promise<RunnerJobState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(`${url}/v1/jobs/${encodeURIComponent(id)}/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new RunnerError(`Runner stream answered ${res.status}`, res.status);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) {
            continue;
          }
          const event = JSON.parse(data) as RunnerStreamEvent;
          if (event.type === "output") {
            onOutput(event.data);
          } else {
            return event.state;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    return client.get(id);
  }

  return client;
}

// The tools the runner really has, its standard ones and those a derived image declares, so a
// colleague knows what it can use there. Asked once every five minutes; null when unreachable.
const RUNNER_INTERNALS = new Set(["sh", "prlimit", "setpriv", "ssh-keyscan", "sshpass"]);
const toolsCache = new WeakMap<RunnerClient, { at: number; tools: string[] }>();

export async function runnerTools(runner: RunnerClient): Promise<string[] | null> {
  const cached = toolsCache.get(runner);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return cached.tools;
  }
  try {
    const health = await runner.health();
    const tools = health.tools.filter((tool) => !RUNNER_INTERNALS.has(tool));
    toolsCache.set(runner, { at: Date.now(), tools });
    return tools;
  } catch {
    return null;
  }
}
