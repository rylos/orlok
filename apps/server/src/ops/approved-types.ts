import type { ApprovedCommandType, ShellKind } from "@orlok/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type ApprovedCommandTypeRow, approvedCommandTypes } from "../db/schema";
import { audit } from "./audit";
import type { TypeApprovals } from "./classifier";
import { typeKey } from "./command-types";

// Command types one person approved "always" (R-OPS-4): `systemctl restart` approved
// once spares that person the question with every colleague of theirs, on every host and on the
// runner. Nobody else: the judgement behind "always" is theirs. The owner reviews them in
// Account, an administrator in People; changes are logged in the installation log.

export function toApprovedType(row: ApprovedCommandTypeRow): ApprovedCommandType {
  return {
    id: row.id,
    userId: row.userId,
    shell: row.shell,
    type: row.type,
    disabledBy: row.disabledAt === null ? null : row.disabledByAdmin ? "admin" : "owner",
    createdAt: row.createdAt.toISOString(),
  };
}

// What the classifier needs to know about one person: the types they approved, and those an
// administrator disabled.
export async function typeApprovalsFor(db: Db, userId: string): Promise<TypeApprovals> {
  const rows = await db
    .select()
    .from(approvedCommandTypes)
    .where(eq(approvedCommandTypes.userId, userId));
  return {
    approved: new Set(
      rows.filter((row) => row.disabledAt === null).map((row) => typeKey(row.shell, row.type)),
    ),
    blocked: new Set(
      rows.filter((row) => row.disabledByAdmin).map((row) => typeKey(row.shell, row.type)),
    ),
  };
}

// "Always": the types are remembered for the person, and those they had disabled are enabled
// again. A type an administrator disabled stays disabled. Returns the types now approved.
export async function approveTypes(
  db: Db,
  input: { userId: string; shell: ShellKind; types: string[] },
): Promise<string[]> {
  const rows = await db
    .select()
    .from(approvedCommandTypes)
    .where(
      and(
        eq(approvedCommandTypes.userId, input.userId),
        eq(approvedCommandTypes.shell, input.shell),
      ),
    );
  const known = new Map(rows.map((row) => [typeKey(row.shell, row.type), row]));
  const approved: string[] = [];
  for (const type of input.types) {
    const row = known.get(typeKey(input.shell, type));
    if (!row) {
      await db
        .insert(approvedCommandTypes)
        .values({ userId: input.userId, shell: input.shell, type })
        .onConflictDoNothing();
      approved.push(type);
    } else if (!row.disabledByAdmin) {
      if (row.disabledAt !== null) {
        await db
          .update(approvedCommandTypes)
          .set({ disabledAt: null })
          .where(eq(approvedCommandTypes.id, row.id));
      }
      approved.push(row.type);
    }
  }
  return approved;
}

export async function listApprovedTypes(db: Db, userId: string): Promise<ApprovedCommandType[]> {
  const rows = await db
    .select()
    .from(approvedCommandTypes)
    .where(eq(approvedCommandTypes.userId, userId))
    .orderBy(asc(approvedCommandTypes.shell), asc(approvedCommandTypes.type));
  return rows.map(toApprovedType);
}

export async function findApprovedType(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(approvedCommandTypes)
    .where(eq(approvedCommandTypes.id, id))
    .limit(1);
  return row ?? null;
}

// Turns a type off or on again, by its owner or by an administrator, and logs it in the
// installation log: approved types belong to the person, not to an office.
export async function setTypeDisabled(
  db: Db,
  row: ApprovedCommandTypeRow,
  input: { disabled: boolean; byAdmin: boolean; actorUserId: string },
) {
  const [updated] = await db
    .update(approvedCommandTypes)
    .set(
      input.disabled
        ? { disabledAt: new Date(), disabledByAdmin: input.byAdmin }
        : { disabledAt: null, disabledByAdmin: false },
    )
    .where(eq(approvedCommandTypes.id, row.id))
    .returning();
  await audit(db, {
    officeId: null,
    actor: { userId: input.actorUserId },
    action: input.disabled ? "command_type.disable" : "command_type.enable",
    target: row.type,
    detail: { owner: row.userId, shell: row.shell },
  });
  return updated ? toApprovedType(updated) : null;
}

export async function deleteApprovedType(db: Db, row: ApprovedCommandTypeRow, actorUserId: string) {
  await db.delete(approvedCommandTypes).where(eq(approvedCommandTypes.id, row.id));
  await audit(db, {
    officeId: null,
    actor: { userId: actorUserId },
    action: "command_type.delete",
    target: row.type,
    detail: { owner: row.userId, shell: row.shell },
  });
}
