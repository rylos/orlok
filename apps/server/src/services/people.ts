import type { Invitation, OfficeMembership, Person } from "@orlok/shared";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type InvitationRow,
  invitationOffices,
  invitationProfiles,
  invitations,
  modelProfiles,
  officeMembers,
  offices,
  profileGrants,
  type UserRow,
  users,
} from "../db/schema";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// An administrator works in every office, so none are assigned; any left from before 2026-10-06,
// when promoting someone kept them, mean nothing and are not shown.
export function toPerson(
  user: UserRow,
  memberships: OfficeMembership[],
  profileIds: string[],
): Person {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    disabled: user.disabledAt !== null,
    memberships: user.role === "admin" ? [] : memberships,
    profileIds,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toInvitation(
  row: InvitationRow,
  memberships: OfficeMembership[],
  profileIds: string[],
  invitedByName: string | null,
): Invitation {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    locale: row.locale,
    memberships: row.role === "admin" ? [] : memberships,
    profileIds,
    invitedByName,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function membershipsByUser(db: Db, userIds: string[]) {
  const rows =
    userIds.length === 0
      ? []
      : await db
          .select({
            userId: officeMembers.userId,
            officeId: officeMembers.officeId,
            role: officeMembers.role,
          })
          .from(officeMembers)
          .where(inArray(officeMembers.userId, userIds));
  const map = new Map<string, OfficeMembership[]>();
  for (const row of rows) {
    map.set(row.userId, [
      ...(map.get(row.userId) ?? []),
      { officeId: row.officeId, role: row.role },
    ]);
  }
  return map;
}

// Model profiles granted to each person (R-MOD-2).
async function grantsByUser(db: Db, userIds: string[]) {
  const rows =
    userIds.length === 0
      ? []
      : await db
          .select({ userId: profileGrants.userId, profileId: profileGrants.profileId })
          .from(profileGrants)
          .where(inArray(profileGrants.userId, userIds));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    map.set(row.userId, [...(map.get(row.userId) ?? []), row.profileId]);
  }
  return map;
}

export async function listPeople(db: Db) {
  const rows = await db.select().from(users).orderBy(asc(users.displayName));
  const ids = rows.map((row) => row.id);
  const memberships = await membershipsByUser(db, ids);
  const grants = await grantsByUser(db, ids);
  return rows.map((row) => toPerson(row, memberships.get(row.id) ?? [], grants.get(row.id) ?? []));
}

export async function findPerson(db: Db, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) {
    return null;
  }
  const memberships = await membershipsByUser(db, [id]);
  const grants = await grantsByUser(db, [id]);
  return toPerson(row, memberships.get(id) ?? [], grants.get(id) ?? []);
}

export async function invitationMemberships(db: Db, invitationIds: string[]) {
  const rows =
    invitationIds.length === 0
      ? []
      : await db
          .select()
          .from(invitationOffices)
          .where(inArray(invitationOffices.invitationId, invitationIds));
  const map = new Map<string, OfficeMembership[]>();
  for (const row of rows) {
    map.set(row.invitationId, [
      ...(map.get(row.invitationId) ?? []),
      { officeId: row.officeId, role: row.role },
    ]);
  }
  return map;
}

export async function invitationProfileIds(db: Db, invitationIds: string[]) {
  const rows =
    invitationIds.length === 0
      ? []
      : await db
          .select()
          .from(invitationProfiles)
          .where(inArray(invitationProfiles.invitationId, invitationIds));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    map.set(row.invitationId, [...(map.get(row.invitationId) ?? []), row.profileId]);
  }
  return map;
}

// Invitations not yet accepted, revoked or expired.
export async function listPendingInvitations(db: Db) {
  const rows = await db
    .select({ invitation: invitations, invitedByName: users.displayName })
    .from(invitations)
    .leftJoin(users, eq(invitations.invitedById, users.id))
    .where(
      and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));
  const ids = rows.map((row) => row.invitation.id);
  const memberships = await invitationMemberships(db, ids);
  const profiles = await invitationProfileIds(db, ids);
  return rows.map((row) =>
    toInvitation(
      row.invitation,
      memberships.get(row.invitation.id) ?? [],
      profiles.get(row.invitation.id) ?? [],
      row.invitedByName,
    ),
  );
}

export async function unknownOfficeIds(db: Db, officeIds: string[]) {
  if (officeIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: offices.id })
    .from(offices)
    .where(inArray(offices.id, officeIds));
  const known = new Set(rows.map((row) => row.id));
  return officeIds.filter((id) => !known.has(id));
}

export async function unknownProfileIds(db: Db, profileIds: string[]) {
  if (profileIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: modelProfiles.id })
    .from(modelProfiles)
    .where(inArray(modelProfiles.id, profileIds));
  const known = new Set(rows.map((row) => row.id));
  return profileIds.filter((id) => !known.has(id));
}

export async function replaceGrants(tx: Transaction, userId: string, profileIds: string[]) {
  await tx.delete(profileGrants).where(eq(profileGrants.userId, userId));
  if (profileIds.length > 0) {
    await tx.insert(profileGrants).values(profileIds.map((profileId) => ({ userId, profileId })));
  }
}

export async function replaceMemberships(
  tx: Transaction,
  userId: string,
  memberships: OfficeMembership[],
) {
  await tx.delete(officeMembers).where(eq(officeMembers.userId, userId));
  if (memberships.length > 0) {
    await tx
      .insert(officeMembers)
      .values(memberships.map((membership) => ({ ...membership, userId })));
  }
}

export async function otherActiveAdminCount(db: Db, userId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.disabledAt), ne(users.id, userId)));
  return row?.total ?? 0;
}
