import type { WikiAuthor } from "@orlok/shared";
import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditEvents, colleagues, offices, users } from "../db/schema";
import {
  colleagueOwners,
  colleagueRefColumns,
  type DbExecutor,
  toColleagueRef,
} from "../services/wiki";

// Append-only audit log (R-SEC-1). Details never contain secrets.

export type AuditActor = { userId: string } | { colleagueId: string } | null;

export async function audit(
  db: DbExecutor,
  event: {
    officeId: string | null;
    actor: AuditActor;
    action: string;
    target?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  await db.insert(auditEvents).values({
    officeId: event.officeId,
    actorUserId: event.actor && "userId" in event.actor ? event.actor.userId : null,
    actorColleagueId: event.actor && "colleagueId" in event.actor ? event.actor.colleagueId : null,
    action: event.action,
    target: event.target ?? null,
    detail: event.detail ?? null,
  });
}

export type AuditEntry = {
  id: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  // A colleague comes with its owner; a deleted one keeps its name (R-ADM-3).
  actor: WikiAuthor;
  createdAt: string;
};

// The events of one office, or with null those of the installation: hosts, people's credentials
// and anything left over from a deleted office.
export async function listAudit(
  db: Db,
  officeId: string | null,
  limit = 200,
): Promise<AuditEntry[]> {
  const rows = await db
    .select({
      event: auditEvents,
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .leftJoin(colleagues, eq(auditEvents.actorColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(officeId ? eq(auditEvents.officeId, officeId) : isNull(auditEvents.officeId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const colleague = toColleagueRef(row);
    return {
      id: row.event.id,
      action: row.event.action,
      target: row.event.target,
      detail: row.event.detail,
      actor:
        row.personName !== null
          ? { kind: "person", name: row.personName }
          : colleague
            ? { kind: "colleague", ...colleague }
            : null,
      createdAt: row.event.createdAt.toISOString(),
    };
  });
}

// Audit export (R-SEC-5): installation and every office, oldest first, as rows with names.
export type AuditExportRow = {
  createdAt: string;
  office: string;
  actorKind: "person" | "colleague" | "system";
  actor: string;
  colleagueOwner: string;
  action: string;
  target: string;
  detail: string;
};

export async function exportAudit(
  db: Db,
  range: { from?: Date; to?: Date },
): Promise<AuditExportRow[]> {
  const rows = await db
    .select({
      event: auditEvents,
      officeName: offices.name,
      personName: users.displayName,
      ...colleagueRefColumns,
    })
    .from(auditEvents)
    .leftJoin(offices, eq(auditEvents.officeId, offices.id))
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .leftJoin(colleagues, eq(auditEvents.actorColleagueId, colleagues.id))
    .leftJoin(colleagueOwners, eq(colleagues.userId, colleagueOwners.id))
    .where(
      and(
        range.from ? gte(auditEvents.createdAt, range.from) : undefined,
        range.to ? lt(auditEvents.createdAt, range.to) : undefined,
      ),
    )
    .orderBy(asc(auditEvents.createdAt));
  return rows.map((row) => ({
    createdAt: row.event.createdAt.toISOString(),
    office: row.officeName ?? "",
    actorKind:
      row.personName !== null ? "person" : row.colleagueName !== null ? "colleague" : "system",
    actor: row.personName ?? row.colleagueName ?? "",
    colleagueOwner: row.personName === null ? (row.colleagueOwner ?? "") : "",
    action: row.event.action,
    target: row.event.target ?? "",
    detail: row.event.detail ? JSON.stringify(row.event.detail) : "",
  }));
}

// A spreadsheet evaluates a cell starting with =, +, -, @, tab or carriage return as a formula:
// an exported value written by a colleague or a command must be shown, never run.
export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function auditCsv(rows: AuditExportRow[]) {
  const columns: (keyof AuditExportRow)[] = [
    "createdAt",
    "office",
    "actorKind",
    "actor",
    "colleagueOwner",
    "action",
    "target",
    "detail",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
}
