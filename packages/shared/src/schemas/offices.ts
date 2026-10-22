import { z } from "zod";
import { COLLEAGUE_INSTRUCTIONS_MAX, COLLEAGUE_NOTES_MAX } from "../offices";
import { issue } from "./issue";

const nameSchema = z.string().trim().min(1, issue("required")).max(80, issue("too_long"));
const descriptionSchema = z.string().trim().max(500, issue("too_long"));
const titleSchema = z.string().trim().max(80, issue("too_long"));
const instructionsSchema = z.string().max(COLLEAGUE_INSTRUCTIONS_MAX, issue("too_long"));
// Every colleague works with a profile: there is no default one (R-MOD-2).
const profileIdSchema = z.uuid(issue("required"));

export const officeCreateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.nullable().optional(),
});

export const officeUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.nullable().optional(),
});

// A person creates their own colleagues, in one of their offices (R-ADM-3).
export const colleagueCreateSchema = z.object({
  officeId: z.uuid(issue("required")),
  name: nameSchema,
  title: titleSchema.default(""),
  instructions: instructionsSchema.default(""),
  profileId: profileIdSchema,
});

export const colleagueUpdateSchema = z.object({
  name: nameSchema.optional(),
  title: titleSchema.optional(),
  instructions: instructionsSchema.optional(),
  notes: z.string().max(COLLEAGUE_NOTES_MAX, issue("too_long")).optional(),
  profileId: profileIdSchema.optional(),
  archived: z.boolean().optional(),
});

// The office colleague, set up by an administrator (R-ADM-8): any profile, no private notes.
export const officeColleagueCreateSchema = colleagueCreateSchema.omit({ officeId: true });

export const officeColleagueUpdateSchema = colleagueUpdateSchema.omit({ notes: true });
