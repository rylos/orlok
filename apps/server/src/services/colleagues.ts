import type { Colleague, Me } from "@orlok/shared";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type ColleagueRow,
  chatAttachments,
  colleagues,
  conversations,
  offices,
  opsJobs,
  opsPlans,
  profileGrants,
  users,
} from "../db/schema";
import { canAccessOffice } from "./offices";
import type { DbExecutor } from "./wiki";

// Colleagues are personal (R-ADM-3): each belongs to the person who created it, works only for
// them and only with the profiles they are granted (R-MOD-2). The office colleague is the
// exception (R-ADM-8): an administrator sets it up with any profile, everyone in the office talks
// with it, and it only reads the wiki.

export function toColleague(row: ColleagueRow, needsProfile: boolean): Colleague {
  return {
    id: row.id,
    officeId: row.officeId,
    name: row.name,
    title: row.title,
    instructions: row.instructions,
    notes: row.notes,
    profileId: row.profileId,
    needsProfile,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    officeWide: row.officeWide,
    createdAt: row.createdAt.toISOString(),
  };
}

// Neither archived nor deleted: a colleague that answers, as long as it has a profile.
export function isActive(row: ColleagueRow) {
  return row.archivedAt === null && row.deletedAt === null;
}

// Whether the owner may still give the colleague its profile.
export async function profileGranted(db: Db, userId: string, profileId: string | null) {
  if (!profileId) {
    return false;
  }
  const [row] = await db
    .select({ profileId: profileGrants.profileId })
    .from(profileGrants)
    .where(and(eq(profileGrants.userId, userId), eq(profileGrants.profileId, profileId)))
    .limit(1);
  return row !== undefined;
}

// A colleague of the signed-in person, archived or not, while they can still work in its office.
// Other people's colleagues do not exist for them.
export async function findOwnColleague(db: Db, user: Me, id: string) {
  const [row] = await db
    .select({ colleague: colleagues, office: offices })
    .from(colleagues)
    .innerJoin(offices, eq(colleagues.officeId, offices.id))
    .where(
      and(
        eq(colleagues.id, id),
        eq(colleagues.userId, user.id),
        eq(colleagues.officeWide, false),
        isNull(colleagues.deletedAt),
      ),
    )
    .limit(1);
  if (!row || !(await canAccessOffice(db, user, row.office.id))) {
    return null;
  }
  return row;
}

// A colleague the signed-in person may talk with: one of their own, archived or not, or the
// colleague of one of their offices while it is not archived.
export async function findTalkableColleague(db: Db, user: Me, id: string) {
  const [row] = await db
    .select({ colleague: colleagues, office: offices })
    .from(colleagues)
    .innerJoin(offices, eq(colleagues.officeId, offices.id))
    .where(
      and(
        eq(colleagues.id, id),
        or(
          and(eq(colleagues.userId, user.id), eq(colleagues.officeWide, false)),
          and(eq(colleagues.officeWide, true), isNull(colleagues.archivedAt)),
        ),
        isNull(colleagues.deletedAt),
      ),
    )
    .limit(1);
  if (!row || !(await canAccessOffice(db, user, row.office.id))) {
    return null;
  }
  return row;
}

// The colleague of an office, archived or not (R-ADM-8).
export async function findOfficeColleague(db: Db, officeId: string) {
  const [row] = await db
    .select()
    .from(colleagues)
    .where(
      and(
        eq(colleagues.officeId, officeId),
        eq(colleagues.officeWide, true),
        isNull(colleagues.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Whether a colleague waits for a profile: a personal one needs a profile its owner is still
// granted, the office colleague only one that still exists.
export async function needsProfile(db: Db, row: ColleagueRow) {
  return row.officeWide
    ? row.profileId === null
    : !(await profileGranted(db, row.userId, row.profileId));
}

// A colleague that may work without its owner watching (documents, wiki checks, the end of a
// command): not archived or deleted, and its owner can still sign in. Never the office colleague,
// which only reads.
export async function findWorkingColleague(db: Db, id: string) {
  const [row] = await db
    .select({ colleague: colleagues, office: offices, owner: users })
    .from(colleagues)
    .innerJoin(offices, eq(colleagues.officeId, offices.id))
    .innerJoin(users, eq(colleagues.userId, users.id))
    .where(and(eq(colleagues.id, id), eq(colleagues.officeWide, false)))
    .limit(1);
  if (!row || !isActive(row.colleague) || row.owner.disabledAt) {
    return null;
  }
  return row;
}

// Names are unique for each person in an office, whatever their case; two people may both have
// their own "Sysadmin".
export async function colleagueNameTaken(
  db: Db,
  owner: { userId: string; officeId: string },
  name: string,
  exceptId?: string,
) {
  const [row] = await db
    .select({ id: colleagues.id })
    .from(colleagues)
    .where(
      and(
        eq(colleagues.userId, owner.userId),
        eq(colleagues.officeId, owner.officeId),
        eq(colleagues.officeWide, false),
        sql`lower(${colleagues.name}) = lower(${name})`,
        isNull(colleagues.deletedAt),
        exceptId ? ne(colleagues.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// Deleting keeps the colleague's name and owner, so the wiki history and the audit log still say
// who did what. Its conversations, attachments, instructions and profile go, and the approvals
// still waiting for it are cancelled. The command types its owner approved "always" stay: they
// belong to the person and serve all their colleagues.
export async function deleteColleague(db: Db, row: ColleagueRow) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await cancelWaitingApprovals(tx, [row.id]);
    await tx.delete(conversations).where(eq(conversations.colleagueId, row.id));
    await tx.delete(chatAttachments).where(eq(chatAttachments.colleagueId, row.id));
    await tx
      .update(colleagues)
      .set({
        title: "",
        instructions: "",
        notes: "",
        profileId: null,
        archivedAt: null,
        deletedAt: now,
      })
      .where(eq(colleagues.id, row.id));
  });
}

// Requests still waiting for a decision were asked under the colleague's profile of that moment:
// once it changes, or its owner loses it, they are cancelled rather than left to be approved for
// a colleague that may no longer do what they ask (R-OPS-4). Returns whose they were, so that
// their pages can be told once the change is stored (`waitingChanged`).
export async function cancelWaitingApprovals(
  db: DbExecutor,
  colleagueIds: string[],
  error?: string,
) {
  if (colleagueIds.length === 0) {
    return [];
  }
  const now = new Date();
  const whose = {
    requestedForUserId: opsJobs.requestedForUserId,
    colleagueId: opsJobs.colleagueId,
    conversationId: opsJobs.conversationId,
  };
  const jobs = await db
    .update(opsJobs)
    .set({ status: "stopped", finishedAt: now, ...(error ? { error } : {}) })
    .where(and(inArray(opsJobs.colleagueId, colleagueIds), eq(opsJobs.status, "pending_approval")))
    .returning(whose);
  const plans = await db
    .update(opsPlans)
    .set({ status: "stopped", finishedAt: now })
    .where(
      and(inArray(opsPlans.colleagueId, colleagueIds), eq(opsPlans.status, "pending_approval")),
    )
    .returning({
      requestedForUserId: opsPlans.requestedForUserId,
      colleagueId: opsPlans.colleagueId,
      conversationId: opsPlans.conversationId,
    });
  return [...jobs, ...plans];
}

// The colleagues of a person whose profile they no longer hold.
export async function colleaguesWithoutGrant(db: DbExecutor, userId: string) {
  const rows = await db
    .select({ id: colleagues.id })
    .from(colleagues)
    .leftJoin(
      profileGrants,
      and(
        eq(profileGrants.userId, colleagues.userId),
        eq(profileGrants.profileId, colleagues.profileId),
      ),
    )
    .where(
      and(
        eq(colleagues.userId, userId),
        eq(colleagues.officeWide, false),
        isNull(profileGrants.profileId),
      ),
    );
  return rows.map((row) => row.id);
}
