import { createHash, timingSafeEqual } from "node:crypto";
import type { RunnerHealth, RunnerStreamEvent } from "@orlok/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { z } from "zod";
import type { JobManager } from "./jobs";
import type { McpEvent, McpSessionManager } from "./mcp";
import { jobRequestSchema, mcpMessageSchema, mcpSessionSchema } from "./schemas";

export type RunnerDeps = {
  token: string;
  version: string;
  jobs: JobManager;
  mcp: McpSessionManager;
  tools: () => string[];
};

const HEARTBEAT_MS = 15_000;

export function createRunnerApp(deps: RunnerDeps) {
  const app = new Hono();
  const expectedToken = createHash("sha256").update(deps.token).digest();

  app.get("/v1/health", (c) => {
    const health: RunnerHealth = { ok: true, version: deps.version, tools: deps.tools() };
    return c.json(health);
  });

  app.use("/v1/*", async (c, next) => {
    const match = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    // Hashing first gives equal lengths, as timingSafeEqual requires.
    const given = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    if (!match || !timingSafeEqual(given, expectedToken)) {
      return c.json(error("unauthorized", "Missing or invalid runner token"), 401);
    }
    await next();
  });

  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  app.post("/v1/jobs", async (c) => {
    const parsed = await parseBody(c.req.raw, jobRequestSchema);
    if (!parsed.success) return c.json(parsed.body, 400);
    if (!deps.jobs.submit(parsed.data)) {
      return c.json(error("duplicate_job", "A job with this id already exists"), 409);
    }
    return c.json({ id: parsed.data.id }, 202);
  });

  app.get("/v1/jobs/:id", (c) => {
    const state = deps.jobs.get(c.req.param("id"));
    return state ? c.json(state) : c.json(error("not_found", "Unknown job"), 404);
  });

  app.get("/v1/jobs/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!deps.jobs.get(id)) return c.json(error("not_found", "Unknown job"), 404);
    return streamSSE(c, async (stream) => {
      const queue = new EventQueue<RunnerStreamEvent>();
      const subscription = deps.jobs.subscribe(id, (event) => {
        queue.push(event);
        if (event.type === "end") queue.close();
      });
      if (!subscription) return;
      if (subscription.replay) queue.unshift({ type: "output", data: subscription.replay });
      if (subscription.state.finishedAt !== null) {
        queue.push({ type: "end", state: subscription.state });
        queue.close();
      }
      await pipe(stream, queue, subscription.unsubscribe, (event) => ({
        data: JSON.stringify(event),
      }));
    });
  });

  app.post("/v1/jobs/:id/stop", async (c) => {
    const state = await deps.jobs.stop(c.req.param("id"));
    return state ? c.json(state) : c.json(error("not_found", "Unknown job"), 404);
  });

  app.post("/v1/mcp/sessions", async (c) => {
    const parsed = await parseBody(c.req.raw, mcpSessionSchema);
    if (!parsed.success) return c.json(parsed.body, 400);
    const result = deps.mcp.create(parsed.data);
    if (result === "duplicate") {
      return c.json(error("duplicate_session", "A session with this id already exists"), 409);
    }
    if (result === "limit") {
      return c.json(error("too_many_sessions", "The MCP session limit is reached"), 429);
    }
    return c.json({ id: parsed.data.id }, 201);
  });

  app.post("/v1/mcp/sessions/:id/messages", async (c) => {
    const parsed = await parseBody(c.req.raw, mcpMessageSchema);
    if (!parsed.success) return c.json(parsed.body, 400);
    const result = await deps.mcp.send(c.req.param("id"), parsed.data);
    if (result === "not_found") return c.json(error("not_found", "Unknown session"), 404);
    if (result === "closed") {
      return c.json(error("session_closed", "The MCP server process has exited"), 409);
    }
    return c.body(null, 202);
  });

  app.get("/v1/mcp/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const queue = new EventQueue<McpEvent>();
      const subscription = deps.mcp.subscribe(id, (event) => {
        queue.push(event);
        if (event.event === "exit") queue.close();
      });
      if (!subscription) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "not_found" }) });
        return;
      }
      for (const event of subscription.backlog) queue.push(event);
      if (subscription.exited) queue.close();
      await pipe(stream, queue, subscription.unsubscribe, (event) =>
        event.event === "message" ? { data: event.data } : { event: event.event, data: event.data },
      );
    });
  });

  app.delete("/v1/mcp/sessions/:id", async (c) => {
    const deleted = await deps.mcp.delete(c.req.param("id"));
    return deleted ? c.body(null, 204) : c.json(error("not_found", "Unknown session"), 404);
  });

  return app;
}

function error(code: string, message: string) {
  return { code, message };
}

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<
  { success: true; data: z.infer<T> } | { success: false; body: ReturnType<typeof error> }
> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { success: false, body: error("invalid_body", "The body must be valid JSON") };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      success: false,
      body: {
        ...error("invalid_body", "The body does not match the expected shape"),
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      } as ReturnType<typeof error>,
    };
  }
  return { success: true, data: result.data };
}

async function pipe<T>(
  stream: SSEStreamingApi,
  queue: EventQueue<T>,
  unsubscribe: () => void,
  format: (item: T) => { data: string; event?: string },
) {
  stream.onAbort(() => {
    unsubscribe();
    queue.close();
  });
  const heartbeat = setInterval(() => {
    void stream.write(": ping\n\n");
  }, HEARTBEAT_MS);
  try {
    for await (const item of queue) {
      await stream.writeSSE(format(item));
    }
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
  }
}

class EventQueue<T> {
  #items: T[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  push(item: T) {
    if (this.#closed) return;
    this.#items.push(item);
    this.#notify();
  }

  unshift(item: T) {
    this.#items.unshift(item);
    this.#notify();
  }

  close() {
    this.#closed = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.#items.length > 0) yield this.#items.shift() as T;
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
