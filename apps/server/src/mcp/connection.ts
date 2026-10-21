import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerRow, McpToolRecord } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import type { RunnerClient } from "../ops/runner-client";

// Connections to MCP servers (R-OPS-10) with the official SDK. Local (stdio) servers run
// inside the runner, never in the Orlok server process.

const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 10 * 60_000;

export type McpDeps = { runner: RunnerClient | null; secretKey: Buffer };

export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUnavailableError";
  }
}

// Transport over the runner's stdio bridge.
class RunnerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly runner: RunnerClient,
    private readonly session: {
      id: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    },
  ) {}

  async start() {
    await this.runner.mcpOpen(this.session);
    this.runner
      .mcpEvents(
        this.session.id,
        {
          onMessage: (message) => this.onmessage?.(message as JSONRPCMessage),
          onExit: () => this.finish(),
        },
        this.abort.signal,
      )
      .catch((error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.finish();
      });
  }

  async send(message: JSONRPCMessage) {
    await this.runner.mcpSend(this.session.id, message);
  }

  async close() {
    this.abort.abort();
    await this.runner.mcpClose(this.session.id).catch(() => undefined);
    this.finish();
  }

  private finish() {
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  }
}

function secretsOf(server: McpServerRow, secretKey: Buffer): Record<string, string> {
  if (!server.secretsEncrypted) {
    return {};
  }
  return JSON.parse(decryptSecret(server.secretsEncrypted, secretKey)) as Record<string, string>;
}

async function connect(server: McpServerRow, deps: McpDeps) {
  const secrets = secretsOf(server, deps.secretKey);
  let transport: Transport;
  if (server.transport === "http") {
    if (!server.url) {
      throw new McpUnavailableError("The MCP server has no URL");
    }
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: secrets },
    });
  } else {
    if (!deps.runner) {
      throw new McpUnavailableError("Local MCP servers need the Orlok runner");
    }
    if (!server.command) {
      throw new McpUnavailableError("The MCP server has no command");
    }
    transport = new RunnerStdioTransport(deps.runner, {
      id: randomUUID(),
      command: server.command,
      args: server.args,
      env: secrets,
    });
  }
  const client = new Client({ name: "orlok", version: "1.0.0" });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
}

type PooledClient = { client: Client; version: string; lastUsed: number };
const pool = new Map<string, PooledClient>();

// One connection per server, reused while its configuration does not change.
async function clientFor(server: McpServerRow, deps: McpDeps) {
  const version = server.updatedAt.toISOString();
  const pooled = pool.get(server.id);
  if (pooled && pooled.version === version) {
    pooled.lastUsed = Date.now();
    return pooled.client;
  }
  if (pooled) {
    pool.delete(server.id);
    void pooled.client.close().catch(() => undefined);
  }
  const client = await connect(server, deps);
  const entry = { client, version, lastUsed: Date.now() };
  pool.set(server.id, entry);
  client.onclose = () => {
    if (pool.get(server.id) === entry) {
      pool.delete(server.id);
    }
  };
  return client;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pool) {
    if (now - entry.lastUsed > IDLE_CLOSE_MS) {
      pool.delete(id);
      void entry.client.close().catch(() => undefined);
    }
  }
}, 60_000).unref();

export async function closeMcpConnection(serverId: string) {
  const entry = pool.get(serverId);
  if (entry) {
    pool.delete(serverId);
    await entry.client.close().catch(() => undefined);
  }
}

export async function listMcpTools(server: McpServerRow, deps: McpDeps): Promise<McpToolRecord[]> {
  const client = await clientFor(server, deps);
  const tools: McpToolRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: CONNECT_TIMEOUT_MS,
    });
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: tool.description ?? null,
        readOnly: tool.annotations?.readOnlyHint === true,
        destructive:
          tool.annotations?.destructiveHint !== false && tool.annotations?.readOnlyHint !== true,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }
    cursor = page.nextCursor;
  } while (cursor && tools.length < 500);
  return tools;
}

export type McpCallResult = { isError: boolean; text: string };

export async function callMcpTool(
  server: McpServerRow,
  deps: McpDeps,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<McpCallResult> {
  const client = await clientFor(server, deps);
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: timeoutMs,
  });
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content as {
    type: string;
    text?: string;
    resource?: { uri?: string; text?: string };
  }[]) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "resource" && item.resource) {
      parts.push(item.resource.text ?? `[resource ${item.resource.uri ?? ""}]`);
    } else {
      parts.push(`[${item.type} content]`);
    }
  }
  if (parts.length === 0 && "structuredContent" in result && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return { isError: result.isError === true, text: parts.join("\n") };
}
