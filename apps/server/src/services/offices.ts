import type { AdminOffice, Me, Office, WorkspaceColleague, WorkspaceOffice } from "@orlok/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  colleagues,
  conversations,
  type OfficeRow,
  officeMembers,
  offices,
  profileGrants,
} from "../db/schema";
import { countWikiPages } from "./wiki";

export function toOffice(row: OfficeRow): Office {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

// Offices a person can work in: every office for administrators, assigned offices otherwise.
async function accessibleOfficeIds(db: Db, user: Me): Promise<string[] | "all"> {
  if (user.role === "admin") {
    return "all";
  }
  const rows = await db
    .select({ officeId: officeMembers.officeId })
    .from(officeMembers)
    .where(eq(officeMembers.userId, user.id));
  return rows.map((row) => row.officeId);
}

export async function canAccessOffice(db: Db, user: Me, officeId: string) {
  const ids = await accessibleOfficeIds(db, user);
  return ids === "all" || ids.includes(officeId);
}

export async function listWorkspaceOffices(db: Db, user: Me): Promise<WorkspaceOffice[]> {
  const ids = await accessibleOfficeIds(db, user);
  if (ids !== "all" && ids.length === 0) {
    return [];
  }
  const officeRows = await db
    .select()
    .from(offices)
    .where(ids === "all" ? undefined : inArray(offices.id, ids))
    .orderBy(asc(offices.name));
  if (officeRows.length === 0) {
    return [];
  }
  // Only the person's own colleagues: others' are private (R-ADM-3).
  const colleagueRows = await db
    .select()
    .from(colleagues)
    .where(
      and(
        eq(colleagues.userId, user.id),
        isNull(colleagues.deletedAt),
        inArray(
          colleagues.officeId,
          officeRows.map((office) => office.id),
        ),
      ),
    )
    .orderBy(asc(colleagues.name));
  const granted = new Set(
    (
      await db
        .select({ profileId: profileGrants.profileId })
        .from(profileGrants)
        .where(eq(profileGrants.userId, user.id))
    ).map((row) => row.profileId),
  );
  // Only the person's own conversations: others' are private.
  const talked = await db
    .select({
      colleagueId: conversations.colleagueId,
      at: sql<Date>`max(${conversations.updatedAt})`,
    })
    .from(conversations)
    .where(eq(conversations.userId, user.id))
    .groupBy(conversations.colleagueId);
  const lastTalked = new Map(talked.map((row) => [row.colleagueId, new Date(row.at)]));

  return officeRows.map((office) => {
    const inOffice = colleagueRows.filter((colleague) => colleague.officeId === office.id);
    const toItem = (colleague: (typeof colleagueRows)[number]): WorkspaceColleague => ({
      id: colleague.id,
      name: colleague.name,
      title: colleague.title,
      needsProfile: !colleague.profileId || !granted.has(colleague.profileId),
      lastTalkedAt: lastTalked.get(colleague.id)?.toISOString() ?? null,
    });
    return {
      id: office.id,
      name: office.name,
      description: office.description,
      colleagues: inOffice.filter((colleague) => !colleague.archivedAt).map(toItem),
      archived: inOffice.filter((colleague) => colleague.archivedAt).map(toItem),
    };
  });
}

// Offices for administrators. Colleagues are not listed: they belong to each person.
export async function listAdminOffices(db: Db): Promise<AdminOffice[]> {
  const officeRows = await db.select().from(offices).orderBy(asc(offices.name));
  const pageCounts = await countWikiPages(db);
  return officeRows.map((office) => ({
    ...toOffice(office),
    wikiPages: pageCounts.get(office.id) ?? 0,
  }));
}

export async function findOffice(db: Db, id: string) {
  const [row] = await db.select().from(offices).where(eq(offices.id, id)).limit(1);
  return row ?? null;
}
