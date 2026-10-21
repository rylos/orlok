import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ConversationSummary, McpServer, ModelProvider, Office, OpsJob } from "@orlok/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { OPS_WAITS } from "../ops/tools";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];
let script: ChatChunk[][] = [];
const restarted: string[] = [];
const authHeaders: (string | undefined)[] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push({ ...request, messages: [...request.messages] });
    for (const chunk of script.shift() ?? [{ type: "text", text: "OK" }]) {
      yield chunk;
    }
    yield { type: "done", stopReason: "end_turn", usage: null };
  },
});

// A small real MCP server (streamable HTTP, stateless) with a read-only and a destructive tool.
function buildMcpServer() {
  const server = new SdkMcpServer({ name: "pve-test", version: "1.0.0" });
  server.registerTool(
    "vm_status",
    {
      title: "VM status",
      description: "Status of a virtual machine",
      inputSchema: { vmid: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ vmid }) => ({ content: [{ type: "text", text: `VM ${vmid} is running` }] }),
  );
  server.registerTool(
    "vm_restart",
    {
      description: "Restart a virtual machine",
      inputSchema: { vmid: z.number() },
      annotations: { destructiveHint: true },
    },
    async ({ vmid }) => {
      restarted.push(String(vmid));
      return { content: [{ type: "text", text: `VM ${vmid} restarted` }] };
    },
  );
  return server;
}

let http: Server;
let mcpUrl: string;

beforeAll(async () => {
  http = createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  mcpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  // The pooled MCP client keeps connections alive.
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await deps.close();
});

const app = createApp({ ...deps, llm: fakeLlm });
let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  restarted.length = 0;
  authHeaders.length = 0;
  script = [];
  OPS_WAITS.approvalMs = 5_000;
  OPS_WAITS.runMs = 5_000;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

function toolCall(name: string, input: unknown, id = name): ChatChunk {
  return { type: "tool_calls", calls: [{ id, name, input }] };
}

describe("MCP servers", () => {
  it("lists tools with the stored secret and lets the office's colleagues use them", async () => {
    const provider = await call<ModelProvider>("/admin/providers", "POST", {
      name: "Provider",
      kind: "anthropic",
      apiKey: "x",
    });
    const { id: profileId } = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "Profile",
        providerId: provider.body.id,
        model: "model",
        mode: "ask",
      })
    ).body;
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    const sales = (await call<Office>("/admin/offices", "POST", { name: "Sales" })).body;
    const colleague = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.id,
        profileId,
        name: "Sysadmin",
      })
    ).body;
    const elsewhere = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: sales.id,
        profileId,
        name: "Sysadmin",
      })
    ).body;

    const created = await call<McpServer>(`/admin/offices/${office.id}/mcp-servers`, "POST", {
      name: "pve",
      transport: "http",
      url: mcpUrl,
      secrets: { Authorization: "Bearer mcp-token-123" },
    });
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({ secretNames: ["Authorization"], lastError: null });
    expect(created.body.tools).toEqual([
      expect.objectContaining({ name: "vm_status", readOnly: true, destructive: false }),
      expect.objectContaining({ name: "vm_restart", readOnly: false, destructive: true }),
    ]);
    expect(authHeaders).toContain("Bearer mcp-token-123");
    expect(JSON.stringify(created.body)).not.toContain("mcp-token-123");

    // Tools are offered to every colleague of the office, and to nobody elsewhere (R-OPS-10).
    script = [[{ type: "text", text: "Hi" }]];
    let conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: elsewhere.id,
    });
    let res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "Hello" }, adminCookie),
    );
    parseSse(await res.text());
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("mcp__pve__vm_status");

    requests.length = 0;
    script = [
      [toolCall("mcp__pve__vm_status", { vmid: 101 })],
      [toolCall("mcp__pve__vm_restart", { vmid: 101 })],
      [{ type: "text", text: "Done" }],
    ];
    conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "Restart VM 101 if it hangs" }, adminCookie),
    );
    const body = res.text();

    let pending: OpsJob | undefined;
    for (let attempt = 0; attempt < 50 && !pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pending = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body.find(
        (job) => job.status === "pending_approval",
      );
    }
    expect(pending).toMatchObject({ target: { kind: "mcp", name: "pve", tool: "vm_restart" } });
    expect(restarted).toEqual([]);
    await call(`/offices/${office.id}/ops/jobs/${pending?.id}/decision`, "POST", {
      choice: "once",
    });
    parseSse(await body);

    const statusResult = requests[1]?.messages.at(-1);
    expect(statusResult?.role === "tool" ? statusResult.results[0]?.content : "").toContain(
      "VM 101 is running",
    );
    const restartResult = requests[2]?.messages.at(-1);
    expect(restartResult?.role === "tool" ? restartResult.results[0]?.content : "").toContain(
      "VM 101 restarted",
    );
    expect(restarted).toEqual(["101"]);
  });

  it("offers the office's colleagues only the tools chosen", async () => {
    const provider = await call<ModelProvider>("/admin/providers", "POST", {
      name: "Provider",
      kind: "anthropic",
      apiKey: "x",
    });
    const { id: profileId } = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "Profile",
        providerId: provider.body.id,
        model: "model",
        mode: "ask",
      })
    ).body;
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    const colleague = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.id,
        profileId,
        name: "Sonnet",
      })
    ).body;

    const created = await call<McpServer>(`/admin/offices/${office.id}/mcp-servers`, "POST", {
      name: "pve",
      transport: "http",
      url: mcpUrl,
      allowedTools: ["vm_status"],
    });
    expect(created.res.status).toBe(201);
    expect(created.body.allowedTools).toEqual(["vm_status"]);
    // Every tool is still known, for whoever wants to change the choice later.
    expect(created.body.tools.map((tool) => tool.name)).toEqual(["vm_status", "vm_restart"]);

    script = [[{ type: "text", text: "Hi" }]];
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    const res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "Hello" }, adminCookie),
    );
    parseSse(await res.text());
    const offered = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(offered).toContain("mcp__pve__vm_status");
    expect(offered).not.toContain("mcp__pve__vm_restart");

    // Given every tool back.
    const updated = await call<McpServer>(
      `/admin/offices/${office.id}/mcp-servers/${created.body.id}`,
      "PATCH",
      { allowedTools: null },
    );
    expect(updated.body.allowedTools).toBeNull();
  });
});
