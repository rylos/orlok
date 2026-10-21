import { z } from "zod";
import {
  EMBEDDING_MODES,
  WIKI_CONTENT_MAX,
  WIKI_IMPORT_FILES_MAX,
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  WIKI_REVIEW_STATUSES,
  WIKI_SECTION_MAX,
  WIKI_SLUG_MAX,
  WIKI_SLUG_PATTERN,
  WIKI_SOURCE_MAX,
  WIKI_SOURCES_MAX,
  WIKI_SUMMARY_MAX,
  WIKI_SYNONYMS_MAX,
  WIKI_TITLE_MAX,
} from "../wiki";
import { requiredText } from "./fields";
import { issue } from "./issue";

export const wikiSlugSchema = z
  .string()
  .trim()
  .max(WIKI_SLUG_MAX, issue("too_long"))
  .regex(WIKI_SLUG_PATTERN, issue("invalid_slug"));

const sectionSchema = z
  .string()
  .trim()
  .max(WIKI_SECTION_MAX, issue("too_long"))
  .transform((value) => value || null)
  .nullable();

const sourcesSchema = z
  .array(z.string().trim().min(1, issue("required")).max(WIKI_SOURCE_MAX, issue("too_long")))
  .max(WIKI_SOURCES_MAX, issue("too_long"));

const contentSchema = z.string().max(WIKI_CONTENT_MAX, issue("too_long"));

const statusSchema = z.enum(WIKI_PAGE_STATUSES, issue("invalid_value"));

// A calendar day, YYYY-MM-DD.
export const wikiDateSchema = z.iso.date(issue("invalid_value"));

const summarySchema = z
  .string()
  .trim()
  .max(WIKI_SUMMARY_MAX, issue("too_long"))
  .transform((value) => value || null)
  .nullable();

export const wikiPageCreateSchema = z.object({
  // Derived from the title when omitted.
  slug: wikiSlugSchema.optional(),
  title: requiredText(WIKI_TITLE_MAX),
  section: sectionSchema.default(null),
  type: z.enum(WIKI_PAGE_TYPES, issue("invalid_value")).default("note"),
  sources: sourcesSchema.default([]),
  content: contentSchema.default(""),
  status: statusSchema.default("current"),
  verifiedOn: wikiDateSchema.nullable().default(null),
  summary: summarySchema.optional(),
});

// The slug is permanent because other pages link to it. baseRevision detects concurrent edits.
export const wikiPageUpdateSchema = z.object({
  baseRevision: z.int(issue("invalid_value")).min(1, issue("invalid_value")),
  title: requiredText(WIKI_TITLE_MAX).optional(),
  section: sectionSchema.optional(),
  type: z.enum(WIKI_PAGE_TYPES, issue("invalid_value")).optional(),
  sources: sourcesSchema.optional(),
  content: contentSchema.optional(),
  status: statusSchema.optional(),
  verifiedOn: wikiDateSchema.nullable().optional(),
  summary: summarySchema.optional(),
});

export const wikiSlugParamSchema = z.object({
  officeId: z.uuid(issue("invalid_value")),
  slug: wikiSlugSchema,
});

export const wikiRevisionParamSchema = wikiSlugParamSchema.extend({
  revision: z.coerce.number().int(issue("invalid_value")).min(1, issue("invalid_value")),
});

export const wikiOfficeParamSchema = z.object({
  officeId: z.uuid(issue("invalid_value")),
});

export const wikiSourceParamSchema = z.object({
  officeId: z.uuid(issue("invalid_value")),
  id: z.uuid(issue("invalid_value")),
});

export const wikiSearchQuerySchema = z.object({
  q: z.string().trim().min(1, issue("required")).max(200, issue("too_long")),
});

// Markdown files from a folder (R-MEM-11): an Obsidian vault or a Joplin "Markdown + Front
// Matter" export. Folders become sections and relative links between files become wiki links.
export const wikiImportSchema = z.object({
  section: sectionSchema.default(null),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1, issue("required")).max(1_000, issue("too_long")),
        content: contentSchema,
      }),
    )
    .min(1, issue("required"))
    .max(WIKI_IMPORT_FILES_MAX, issue("too_long")),
});

export const documentSettingsSchema = z.object({
  visionProfileId: z.uuid(issue("invalid_value")).nullable(),
});

export const wikiSearchSettingsSchema = z.object({
  queryRewrite: z.boolean(issue("invalid_value")),
  queryProfileId: z.uuid(issue("invalid_value")).nullable(),
});

export const embeddingSettingsSchema = z.object({
  mode: z.enum(EMBEDDING_MODES, issue("invalid_value")),
  providerId: z.uuid(issue("invalid_value")).nullable(),
  model: z
    .string()
    .trim()
    .max(200, issue("too_long"))
    .transform((value) => value || null)
    .nullable(),
});

export const wikiPurposeSchema = z.object({
  purpose: z
    .string()
    .trim()
    .max(4_000, issue("too_long"))
    .transform((value) => value || null)
    .nullable(),
});

export const wikiSynonymsSchema = z.object({
  synonyms: z
    .string()
    .trim()
    .max(WIKI_SYNONYMS_MAX, issue("too_long"))
    .transform((value) => value || null)
    .nullable(),
});

// A round of critical reading by a virtual colleague of the office (R-MEM-14).
export const wikiCheckSchema = z.object({
  colleagueId: z.uuid(issue("invalid_value")),
});

export const wikiReviewParamSchema = z.object({
  officeId: z.uuid(issue("invalid_value")),
  id: z.uuid(issue("invalid_value")),
});

export const wikiReviewQuerySchema = z.object({
  status: z.enum(WIKI_REVIEW_STATUSES, issue("invalid_value")).optional(),
});

export const wikiReviewUpdateSchema = z.object({
  status: z.enum(["done", "dismissed", "open"], issue("invalid_value")),
});

export const wikiSourceDeleteQuerySchema = z.object({
  // Also delete the pages written only from this document and links to them.
  cascade: z.enum(["true", "false"], issue("invalid_value")).optional(),
});
