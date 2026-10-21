import type { CredentialKind, ExecMode, OpsHost, RunnerTarget, ShellKind } from "@orlok/shared";
import type { hostCreateSchema, hostUpdateSchema } from "@orlok/shared/schemas";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client";
import { credentialHosts, credentials, type HostRow, hosts } from "../db/schema";
import { audit } from "./audit";

// The host registry of the installation (R-OPS-1): administrators keep it, people store their
// own credentials for its hosts. Its audit events belong to no office.

export function toHost(row: HostRow): OpsHost {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    connection: row.connection,
    address: row.address,
    port: row.port,
    tags: row.tags,
    description: row.description,
    enabled: row.enabled,
    hostKey: row.hostKey,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listHosts(db: Db) {
  return db.select().from(hosts).orderBy(asc(hosts.name));
}

export async function findHost(db: Db, id: string) {
  const [row] = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return row ?? null;
}

export async function createHost(db: Db, input: z.infer<typeof hostCreateSchema>, userId: string) {
  const [row] = await db.insert(hosts).values(input).returning();
  if (!row) {
    throw new Error("Host insert returned no row");
  }
  await audit(db, {
    officeId: null,
    actor: { userId },
    action: "host.create",
    target: row.name,
    detail: { kind: row.kind, address: row.address, port: row.port },
  });
  return toHost(row);
}

export async function updateHost(
  db: Db,
  current: HostRow,
  input: z.infer<typeof hostUpdateSchema>,
  userId: string,
) {
  const { resetHostKey, ...fields } = input;
  const addressChanged =
    (fields.address !== undefined && fields.address !== current.address) ||
    (fields.port !== undefined && fields.port !== current.port);
  const [row] = await db
    .update(hosts)
    .set({ ...fields, ...(resetHostKey || addressChanged ? { hostKey: null } : {}) })
    .where(eq(hosts.id, current.id))
    .returning();
  if (!row) {
    return null;
  }
  await audit(db, {
    officeId: null,
    actor: { userId },
    action: "host.update",
    target: row.name,
    detail: { fields: Object.keys(fields), hostKeyReset: Boolean(resetHostKey || addressChanged) },
  });
  return toHost(row);
}

// The credentials stored for it stay, without this host.
export async function deleteHost(db: Db, current: HostRow, userId: string) {
  await db.delete(hosts).where(eq(hosts.id, current.id));
  await audit(db, {
    officeId: null,
    actor: { userId },
    action: "host.delete",
    target: current.name,
  });
}

// --- What a colleague works with (R-OPS-4) --------------------------------------------------

// How a colleague may run commands in a turn: the mode of its profile (R-MOD-2). Where it works
// follows from it: hosts where the person it works for has a credential, the runner and the
// office's MCP servers, nothing at all in deny mode.
export type WorkingPolicy = { mode: ExecMode };

// Enabled hosts where a colleague may work for a person: those the person stored a credential
// for (R-OPS-3), wherever the colleague's office is. No person, no hosts.
export async function allowedHosts(db: Db, userId: string | null, policy: WorkingPolicy) {
  if (policy.mode === "deny" || !userId) {
    return [];
  }
  return db
    .select({ host: hosts, credential: { name: credentials.name, username: credentials.username } })
    .from(credentialHosts)
    .innerJoin(hosts, eq(credentialHosts.hostId, hosts.id))
    .innerJoin(credentials, eq(credentialHosts.credentialId, credentials.id))
    .where(and(eq(credentialHosts.userId, userId), eq(hosts.enabled, true)))
    .orderBy(asc(hosts.name));
}

// Names of the enabled hosts where the person has no credential yet: the colleague tells them
// that a credential of their own is all it takes to work there (R-OPS-3).
export async function hostsWithoutCredential(db: Db, userId: string) {
  const rows = await db
    .select({ name: hosts.name })
    .from(hosts)
    .leftJoin(
      credentialHosts,
      and(eq(credentialHosts.hostId, hosts.id), eq(credentialHosts.userId, userId)),
    )
    .where(and(eq(hosts.enabled, true), isNull(credentialHosts.hostId)))
    .orderBy(asc(hosts.name));
  return rows.map((row) => row.name);
}

// How the runner reaches a host with a person's credential (R-OPS-2, R-OPS-3): SSH with a
// password or a key, or WinRM with a password. A key cannot open WinRM.
export function runnerTargetFor(
  host: HostRow,
  credential: { kind: CredentialKind; username: string; secret: string; passphrase: string | null },
  shell: ShellKind,
): RunnerTarget | { error: "credential_unsupported" } {
  if (host.connection !== "ssh") {
    if (credential.kind !== "password") {
      return { error: "credential_unsupported" };
    }
    return {
      kind: "winrm",
      host: host.address,
      port: host.port,
      username: credential.username,
      password: credential.secret,
      https: host.connection === "winrm_https",
    };
  }
  return {
    kind: "ssh",
    host: host.address,
    port: host.port,
    username: credential.username,
    auth:
      credential.kind === "ssh_key"
        ? {
            type: "key",
            privateKey: credential.secret,
            ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
          }
        : { type: "password", password: credential.secret },
    knownHostKey: host.hostKey,
    shell,
  };
}
