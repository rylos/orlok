import type { z } from "zod";
import type {
  colleagueCreateSchema,
  colleagueUpdateSchema,
  officeColleagueCreateSchema,
  officeColleagueUpdateSchema,
  officeCreateSchema,
  officeUpdateSchema,
} from "./schemas/offices";

// Offices and AI colleagues (R-ADM-2, R-ADM-3).
export const OFFICE_ROLES = ["manager", "member", "observer"] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];

export const COLLEAGUE_INSTRUCTIONS_MAX = 20_000;

export type OfficeCreateInput = z.input<typeof officeCreateSchema>;
export type OfficeUpdateInput = z.input<typeof officeUpdateSchema>;
export type ColleagueCreateInput = z.input<typeof colleagueCreateSchema>;
export type ColleagueUpdateInput = z.input<typeof colleagueUpdateSchema>;
export type OfficeColleagueCreateInput = z.input<typeof officeColleagueCreateSchema>;
export type OfficeColleagueUpdateInput = z.input<typeof officeColleagueUpdateSchema>;

export type Office = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
};

// A colleague as its owner sees it: colleagues are personal, nobody else sees them (R-ADM-3).
// Room for a colleague's private notes: preferences and context, not a second wiki.
export const COLLEAGUE_NOTES_MAX = 4_000;

export type Colleague = {
  id: string;
  officeId: string;
  name: string;
  title: string;
  instructions: string;
  // Private notes about working with its owner (R-MEM-2), kept by the colleague and the owner.
  notes: string;
  // null when its profile was deleted: the colleague then waits for another one.
  profileId: string | null;
  // No profile, or one its owner is no longer granted: it does not answer until another is chosen.
  needsProfile: boolean;
  // Archived colleagues are hidden and do not answer; their conversations are kept.
  archivedAt: string | null;
  // The office colleague (R-ADM-8): set up by an administrator, there for everyone in the office.
  officeWide: boolean;
  createdAt: string;
};

// The office colleague is listed with its office: administrators set it up there (R-ADM-8).
export type AdminOffice = Office & { wikiPages: number; colleague: Colleague | null };

export type WorkspaceColleague = {
  id: string;
  name: string;
  title: string;
  needsProfile: boolean;
  // The office colleague (R-ADM-8): everyone in the office has it, only administrators change it.
  officeWide: boolean;
  // When the signed-in person last talked with the colleague, if ever.
  lastTalkedAt: string | null;
};

// An office with the signed-in person's own colleagues in it.
export type WorkspaceOffice = {
  id: string;
  name: string;
  description: string | null;
  colleagues: WorkspaceColleague[];
  archived: WorkspaceColleague[];
};

export function isOfficeRole(value: unknown): value is OfficeRole {
  return typeof value === "string" && (OFFICE_ROLES as readonly string[]).includes(value);
}
