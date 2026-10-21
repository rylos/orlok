import type { Credential } from "@orlok/shared";
import type { credentialCreateSchema, credentialUpdateSchema } from "@orlok/shared/schemas";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client";
import { type CredentialRow, credentialHosts, credentials, hosts } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { DbExecutor } from "../services/wiki";
import { audit } from "./audit";

// A person's own credentials (R-OPS-3). Secrets are decrypted only to hand them to the runner for
// a single job; the API never returns them. Nothing here belongs to an office, so the audit
// events go to the installation log.

export function toCredential(row: CredentialRow, hostIds: string[]): Credential {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    username: row.username,
    description: row.description,
    hostIds,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

async function hostIdsOf(db: DbExecutor, credentialIds: string[]) {
  const byCredential = new Map<string, string[]>();
  if (credentialIds.length === 0) {
    return byCredential;
  }
  const rows = await db
    .select({ credentialId: credentialHosts.credentialId, hostId: credentialHosts.hostId })
    .from(credentialHosts)
    .innerJoin(hosts, eq(credentialHosts.hostId, hosts.id))
    .where(inArray(credentialHosts.credentialId, credentialIds))
    .orderBy(asc(hosts.name));
  for (const row of rows) {
    byCredential.set(row.credentialId, [...(byCredential.get(row.credentialId) ?? []), row.hostId]);
  }
  return byCredential;
}

export async function listCredentials(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .orderBy(asc(credentials.name));
  const hostIds = await hostIdsOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toCredential(row, hostIds.get(row.id) ?? []));
}

// Someone else's credential is as good as missing.
export async function findCredential(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
    .limit(1);
  return row ?? null;
}

// Why the hosts asked for cannot be given to this credential, if they cannot.
export async function hostsProblem(
  db: Db,
  userId: string,
  hostIds: string[],
  credentialId: string | null,
) {
  if (hostIds.length === 0) {
    return null;
  }
  const known = await db.select({ id: hosts.id }).from(hosts).where(inArray(hosts.id, hostIds));
  if (known.length !== hostIds.length) {
    return "invalid_value" as const;
  }
  // One credential per person per host: the colleague never has two accounts to choose from.
  const taken = await db
    .select({ credentialId: credentialHosts.credentialId })
    .from(credentialHosts)
    .where(and(eq(credentialHosts.userId, userId), inArray(credentialHosts.hostId, hostIds)));
  return taken.some((row) => row.credentialId !== credentialId)
    ? ("host_has_credential" as const)
    : null;
}

async function replaceHosts(db: DbExecutor, credential: CredentialRow, hostIds: string[]) {
  await db.delete(credentialHosts).where(eq(credentialHosts.credentialId, credential.id));
  if (hostIds.length > 0) {
    await db.insert(credentialHosts).values(
      hostIds.map((hostId) => ({
        credentialId: credential.id,
        hostId,
        userId: credential.userId,
      })),
    );
  }
}

export async function createCredential(
  db: Db,
  userId: string,
  input: z.infer<typeof credentialCreateSchema>,
  secretKey: Buffer,
) {
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(credentials)
      .values({
        userId,
        name: input.name,
        kind: input.kind,
        username: input.username,
        description: input.description,
        secretEncrypted: encryptSecret(input.secret, secretKey),
        passphraseEncrypted: input.passphrase ? encryptSecret(input.passphrase, secretKey) : null,
      })
      .returning();
    if (!inserted) {
      throw new Error("Credential insert returned no row");
    }
    await replaceHosts(tx, inserted, input.hostIds);
    await audit(tx, {
      officeId: null,
      actor: { userId },
      action: "credential.create",
      target: inserted.name,
      detail: { kind: inserted.kind, hosts: input.hostIds.length },
    });
    return inserted;
  });
  return toCredential(row, (await hostIdsOf(db, [row.id])).get(row.id) ?? []);
}

export async function updateCredential(
  db: Db,
  current: CredentialRow,
  input: z.infer<typeof credentialUpdateSchema>,
  secretKey: Buffer,
) {
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(credentials)
      .set({
        name: input.name,
        username: input.username,
        description: input.description,
        // Set even when only the hosts change, so the update always has a column to write.
        updatedAt: new Date(),
        ...(input.secret === undefined
          ? {}
          : { secretEncrypted: encryptSecret(input.secret, secretKey) }),
        ...(input.passphrase === undefined
          ? {}
          : {
              passphraseEncrypted: input.passphrase
                ? encryptSecret(input.passphrase, secretKey)
                : null,
            }),
      })
      .where(eq(credentials.id, current.id))
      .returning();
    if (!updated) {
      return null;
    }
    if (input.hostIds) {
      await replaceHosts(tx, updated, input.hostIds);
    }
    await audit(tx, {
      officeId: null,
      actor: { userId: current.userId },
      action: "credential.update",
      target: updated.name,
      detail: {
        secretChanged: input.secret !== undefined,
        ...(input.hostIds ? { hosts: input.hostIds.length } : {}),
      },
    });
    return updated;
  });
  return row ? toCredential(row, (await hostIdsOf(db, [row.id])).get(row.id) ?? []) : null;
}

// Colleagues working for the person lose the hosts of the credential with it.
export async function deleteCredential(db: Db, current: CredentialRow) {
  await db.delete(credentials).where(eq(credentials.id, current.id));
  await audit(db, {
    officeId: null,
    actor: { userId: current.userId },
    action: "credential.delete",
    target: current.name,
  });
}

// A person who is disabled leaves no credential behind: if they come back, they enter them again.
export async function deleteCredentialsOf(db: DbExecutor, userId: string, actorId: string) {
  const deleted = await db
    .delete(credentials)
    .where(eq(credentials.userId, userId))
    .returning({ name: credentials.name });
  for (const credential of deleted) {
    await audit(db, {
      officeId: null,
      actor: { userId: actorId },
      action: "credential.delete",
      target: credential.name,
      detail: { owner: userId, reason: "person_disabled" },
    });
  }
}

// The credential a person uses on one host, if they stored one for it. Read when the command
// runs, not when it is asked for, so a credential changed while an approval waits takes effect.
export async function credentialIdForHost(db: Db, userId: string, hostId: string) {
  const [row] = await db
    .select({ id: credentialHosts.credentialId })
    .from(credentialHosts)
    .where(and(eq(credentialHosts.userId, userId), eq(credentialHosts.hostId, hostId)))
    .limit(1);
  return row?.id ?? null;
}

export type RevealedCredential = {
  kind: CredentialRow["kind"];
  // The name its owner gave it, for the audit log: never the secret.
  name: string;
  username: string | null;
  secret: string;
  passphrase: string | null;
};

export async function revealCredential(db: Db, id: string, secretKey: Buffer) {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
  if (!row) {
    return null;
  }
  await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, id));
  return {
    kind: row.kind,
    name: row.name,
    username: row.username,
    secret: decryptSecret(row.secretEncrypted, secretKey),
    passphrase: row.passphraseEncrypted ? decryptSecret(row.passphraseEncrypted, secretKey) : null,
  } satisfies RevealedCredential;
}
