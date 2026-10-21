import type { McpServer } from "@orlok/shared";
import type { mcpServerCreateSchema, mcpServerUpdateSchema } from "@orlok/shared/schemas";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client";
import { type McpServerRow, mcpServers } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { audit } from "../ops/audit";
import { closeMcpConnection, listMcpTools, type McpDeps } from "./connection";

export function toMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    officeId: row.officeId,
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    secretNames: row.secretNames,
    toolPolicy: row.toolPolicy,
    enabled: row.enabled,
    tools: row.tools.map(({ inputSchema: _schema, ...tool }) => tool),
    allowedTools: row.allowedTools ?? null,
    toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMcpServers(db: Db, officeId: string) {
  return db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.officeId, officeId))
    .orderBy(asc(mcpServers.name));
}

export async function findMcpServer(db: Db, officeId: string, id: string) {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.officeId, officeId)))
    .limit(1);
  return row ?? null;
}

// Every colleague of the office uses its enabled servers (R-OPS-10).
export async function enabledMcpServers(db: Db, officeId: string) {
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.officeId, officeId), eq(mcpServers.enabled, true)))
    .orderBy(asc(mcpServers.name));
}

function encryptSecrets(secrets: Record<string, string>, secretKey: Buffer) {
  return Object.keys(secrets).length > 0 ? encryptSecret(JSON.stringify(secrets), secretKey) : null;
}

export async function createMcpServer(
  db: Db,
  officeId: string,
  input: z.infer<typeof mcpServerCreateSchema>,
  secretKey: Buffer,
  userId: string,
) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      officeId,
      name: input.name,
      description: input.description,
      transport: input.transport,
      url: input.transport === "http" ? input.url : null,
      command: input.transport === "stdio" ? input.command : null,
      args: input.transport === "stdio" ? input.args : [],
      secretsEncrypted: encryptSecrets(input.secrets, secretKey),
      secretNames: Object.keys(input.secrets).sort(),
      toolPolicy: input.toolPolicy,
      enabled: input.enabled,
      allowedTools: input.allowedTools,
    })
    .returning();
  if (!row) {
    throw new Error("MCP server insert returned no row");
  }
  await audit(db, {
    officeId,
    actor: { userId },
    action: "mcp.create",
    target: row.name,
    detail: {
      transport: row.transport,
      url: row.url,
      command: row.command,
      secrets: row.secretNames,
    },
  });
  return row;
}

export async function updateMcpServer(
  db: Db,
  current: McpServerRow,
  input: z.infer<typeof mcpServerUpdateSchema>,
  secretKey: Buffer,
  userId: string,
) {
  let secretFields = {};
  if (input.secrets) {
    const secrets: Record<string, string> = current.secretsEncrypted
      ? (JSON.parse(decryptSecret(current.secretsEncrypted, secretKey)) as Record<string, string>)
      : {};
    for (const [name, value] of Object.entries(input.secrets)) {
      if (value === null) {
        delete secrets[name];
      } else {
        secrets[name] = value;
      }
    }
    secretFields = {
      secretsEncrypted: encryptSecrets(secrets, secretKey),
      secretNames: Object.keys(secrets).sort(),
    };
  }
  const { secrets: _secrets, ...fields } = input;
  const [row] = await db
    .update(mcpServers)
    .set({ ...fields, ...secretFields })
    .where(eq(mcpServers.id, current.id))
    .returning();
  await closeMcpConnection(current.id);
  if (row) {
    await audit(db, {
      officeId: row.officeId,
      actor: { userId },
      action: "mcp.update",
      target: row.name,
      detail: { fields: Object.keys(fields), secretsChanged: Object.keys(input.secrets ?? {}) },
    });
  }
  return row ?? null;
}

export async function deleteMcpServer(db: Db, current: McpServerRow, userId: string) {
  await db.delete(mcpServers).where(eq(mcpServers.id, current.id));
  await closeMcpConnection(current.id);
  await audit(db, {
    officeId: current.officeId,
    actor: { userId },
    action: "mcp.delete",
    target: current.name,
  });
}

// Connects and stores the tool list; failures are kept as lastError for administrators.
export async function refreshMcpTools(db: Db, server: McpServerRow, deps: McpDeps) {
  try {
    const tools = await listMcpTools(server, deps);
    const [row] = await db
      .update(mcpServers)
      .set({ tools, toolsRefreshedAt: new Date(), lastError: null, updatedAt: server.updatedAt })
      .where(eq(mcpServers.id, server.id))
      .returning();
    return row ?? server;
  } catch (error) {
    const [row] = await db
      .update(mcpServers)
      .set({
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        updatedAt: server.updatedAt,
      })
      .where(eq(mcpServers.id, server.id))
      .returning();
    return row ?? server;
  }
}
