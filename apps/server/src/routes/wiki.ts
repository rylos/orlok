import { createHash } from "node:crypto";
import {
  type Me,
  slugify,
  WIKI_DOCUMENT_MAX_BYTES,
  type WikiSourceUploadResult,
} from "@orlok/shared";
import {
  wikiCheckSchema,
  wikiImportSchema,
  wikiOfficeParamSchema,
  wikiPageCreateSchema,
  wikiPageUpdateSchema,
  wikiPurposeSchema,
  wikiReviewParamSchema,
  wikiReviewQuerySchema,
  wikiReviewUpdateSchema,
  wikiRevisionParamSchema,
  wikiSearchQuerySchema,
  wikiSlugParamSchema,
  wikiSourceDeleteQuerySchema,
  wikiSourceParamSchema,
  wikiSynonymsSchema,
} from "@orlok/shared/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { currentUser, requireUser } from "../auth/middleware";
import { colleagues, offices, wikiPages, wikiSources } from "../db/schema";
import { detectDocumentFormat } from "../documents";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import { isActive } from "../services/colleagues";
import { resolveColleagueModel } from "../services/models";
import {
  appendLog,
  findPageRow,
  getPage,
  getRevision,
  getWikiAccess,
  insertPage,
  listLog,
  listPages,
  listRevisions,
  savePageRevision,
  searchPages,
} from "../services/wiki";
import { deleteSourceWithPages } from "../services/wiki-cascade";
import { checkWikiPages, isCheckRunning } from "../services/wiki-check";
import { getWikiGraph, relatedPages } from "../services/wiki-graph";
import { importWiki } from "../services/wiki-import";
import { listSources } from "../services/wiki-ingest";
import {
  applyProposal,
  countOpenReviewItems,
  lintWiki,
  listReviewItems,
  updateReviewItem,
  wikiHealth,
} from "../services/wiki-review";
import type { AppEnv, Deps } from "../types";

const officeNotFound = errorBody("not_found", "Office not found");
const pageNotFound = errorBody("not_found", "Wiki page not found");
const revisionNotFound = errorBody("not_found", "Revision not found");
const editForbidden = errorBody("forbidden", "Only administrators and office managers can edit");
const revisionConflict = errorBody("revision_conflict", "The page was changed in the meantime");
const slugTaken = errorBody("validation_failed", "A page with this slug already exists", [
  { path: "slug", code: "slug_taken" },
]);

const IMPORT_BODY_LIMIT = 50 * 1024 * 1024;
const sourceNotFound = errorBody("not_found", "Document not found");
const invalidColleague = errorBody(
  "validation_failed",
  "Choose one of your virtual colleagues in the office",
  [{ path: "colleagueId", code: "invalid_value" }],
);
const needsProfile = errorBody(
  "colleague_needs_profile",
  "The colleague needs another model profile",
);
const noFiles = errorBody("validation_failed", "No files", [{ path: "files", code: "required" }]);

// Office wiki (R-MEM-1, R-MEM-5, R-MEM-6, R-MEM-9, R-MEM-11), under /offices/:officeId/wiki.
export function wikiRoutes(deps: Deps) {
  const { db } = deps;
  async function access(user: Me, officeId: string) {
    return getWikiAccess(db, user, officeId);
  }

  // Documents are read and pages checked by a colleague of the person asking, in this office,
  // with a profile they still hold (R-ADM-3, R-MOD-2).
  async function colleagueProblem(user: Me, officeId: string, colleagueId: string) {
    const [colleague] = /^[0-9a-f-]{36}$/i.test(colleagueId)
      ? await db
          .select()
          .from(colleagues)
          .where(
            and(
              eq(colleagues.id, colleagueId),
              eq(colleagues.officeId, officeId),
              eq(colleagues.userId, user.id),
              // The office colleague only reads the wiki (R-ADM-8).
              eq(colleagues.officeWide, false),
            ),
          )
          .limit(1)
      : [];
    if (!colleague || !isActive(colleague)) {
      return "invalid";
    }
    return (await resolveColleagueModel(db, colleague)) ? null : "needs_profile";
  }

  return (
    new Hono<AppEnv>()
      .use(requireUser)
      .get("/:officeId/wiki", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        const found = await access(currentUser(c), officeId);
        if (!found) {
          return c.json(officeNotFound, 404);
        }
        return c.json({
          office: { id: found.office.id, name: found.office.name },
          purpose: found.office.wikiPurpose,
          synonyms: found.office.wikiSynonyms,
          canEdit: found.canEdit,
          openReviews: await countOpenReviewItems(db, officeId),
          pages: await listPages(db, officeId),
        });
      })
      .get(
        "/:officeId/wiki/search",
        validate("param", wikiOfficeParamSchema),
        validate("query", wikiSearchQuerySchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          if (!(await access(currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          return c.json(await searchPages(db, officeId, c.req.valid("query").q));
        },
      )
      .get("/:officeId/wiki/graph", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        if (!(await access(currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        return c.json(await getWikiGraph(db, officeId));
      })
      .put(
        "/:officeId/wiki/purpose",
        validate("param", wikiOfficeParamSchema),
        validate("json", wikiPurposeSchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          const found = await access(currentUser(c), officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const { purpose } = c.req.valid("json");
          await db.update(offices).set({ wikiPurpose: purpose }).where(eq(offices.id, officeId));
          return c.json({ purpose });
        },
      )
      // Words that mean the same thing for this office, used by search (R-MEM-4).
      .put(
        "/:officeId/wiki/synonyms",
        validate("param", wikiOfficeParamSchema),
        validate("json", wikiSynonymsSchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          const found = await access(currentUser(c), officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const { synonyms } = c.req.valid("json");
          await db.update(offices).set({ wikiSynonyms: synonyms }).where(eq(offices.id, officeId));
          return c.json({ synonyms });
        },
      )
      .get(
        "/:officeId/wiki/review",
        validate("param", wikiOfficeParamSchema),
        validate("query", wikiReviewQuerySchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          if (!(await access(currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          return c.json(await listReviewItems(db, officeId, c.req.valid("query").status));
        },
      )
      .get("/:officeId/wiki/health", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        if (!(await access(currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        return c.json(await wikiHealth(db, officeId));
      })
      // Starts a round of critical reading; findings arrive in the review queue.
      .post(
        "/:officeId/wiki/review/check",
        validate("param", wikiOfficeParamSchema),
        validate("json", wikiCheckSchema),
        async (c) => {
          const { officeId } = c.req.valid("param");
          const found = await access(currentUser(c), officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const { colleagueId } = c.req.valid("json");
          const problem = await colleagueProblem(currentUser(c), officeId, colleagueId);
          if (problem) {
            return problem === "invalid"
              ? c.json(invalidColleague, 400)
              : c.json(needsProfile, 409);
          }
          if (isCheckRunning(officeId)) {
            return c.json(errorBody("conflict", "A reading is already in progress"), 409);
          }
          void checkWikiPages(deps, officeId, colleagueId).catch((error: unknown) => {
            console.error("Wiki check failed", error);
          });
          return c.json({ started: true }, 202);
        },
      )
      .post("/:officeId/wiki/review/lint", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        const found = await access(currentUser(c), officeId);
        if (!found) {
          return c.json(officeNotFound, 404);
        }
        if (!found.canEdit) {
          return c.json(editForbidden, 403);
        }
        return c.json(await lintWiki(db, officeId));
      })
      .patch(
        "/:officeId/wiki/review/:id",
        validate("param", wikiReviewParamSchema),
        validate("json", wikiReviewUpdateSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const item = await updateReviewItem(
            db,
            officeId,
            id,
            c.req.valid("json").status,
            user.id,
          );
          return item ? c.json(item) : c.json(errorBody("not_found", "Review item not found"), 404);
        },
      )
      // Applies a change a colleague proposed for someone who may not edit the wiki (R-MEM-3).
      .post(
        "/:officeId/wiki/review/:id/apply",
        validate("param", wikiReviewParamSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const result = await applyProposal(db, officeId, id, user.id);
          if (result === "not_found") {
            return c.json(errorBody("not_found", "Proposal not found"), 404);
          }
          if (result === "conflict") {
            return c.json(
              errorBody("revision_conflict", "The page changed after the proposal was written"),
              409,
            );
          }
          return c.body(null, 204);
        },
      )
      .get("/:officeId/wiki/log", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        if (!(await access(currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        return c.json(await listLog(db, officeId));
      })
      .post(
        "/:officeId/wiki/pages",
        validate("param", wikiOfficeParamSchema),
        validate("json", wikiPageCreateSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const { slug: requested, summary, ...fields } = c.req.valid("json");
          const slug = requested ?? slugify(fields.title);
          if (await findPageRow(db, officeId, slug)) {
            return c.json(slugTaken, 409);
          }
          const actor = { userId: user.id };
          await db.transaction(async (tx) => {
            const page = await insertPage(tx, officeId, slug, fields, actor, summary ?? null);
            await appendLog(tx, { officeId, action: "create", slug, title: page.title, actor });
          });
          return c.json(await getPage(db, officeId, slug), 201);
        },
      )
      .get("/:officeId/wiki/pages/:slug", validate("param", wikiSlugParamSchema), async (c) => {
        const { officeId, slug } = c.req.valid("param");
        if (!(await access(currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        const page = await getPage(db, officeId, slug);
        return page ? c.json(page) : c.json(pageNotFound, 404);
      })
      .patch(
        "/:officeId/wiki/pages/:slug",
        validate("param", wikiSlugParamSchema),
        validate("json", wikiPageUpdateSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, slug } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const current = await findPageRow(db, officeId, slug);
          if (!current) {
            return c.json(pageNotFound, 404);
          }
          const { baseRevision, summary, ...changes } = c.req.valid("json");
          if (baseRevision !== current.revision) {
            return c.json(revisionConflict, 409);
          }
          const actor = { userId: user.id };
          const saved = await db.transaction(async (tx) => {
            const page = await savePageRevision(tx, current, changes, actor, summary ?? null);
            if (page) {
              await appendLog(tx, { officeId, action: "update", slug, title: page.title, actor });
            }
            return page;
          });
          return saved ? c.json(await getPage(db, officeId, slug)) : c.json(revisionConflict, 409);
        },
      )
      .delete("/:officeId/wiki/pages/:slug", validate("param", wikiSlugParamSchema), async (c) => {
        const user = currentUser(c);
        const { officeId, slug } = c.req.valid("param");
        const found = await access(user, officeId);
        if (!found) {
          return c.json(officeNotFound, 404);
        }
        if (!found.canEdit) {
          return c.json(editForbidden, 403);
        }
        const deleted = await db.transaction(async (tx) => {
          const [page] = await tx
            .delete(wikiPages)
            .where(and(eq(wikiPages.officeId, officeId), eq(wikiPages.slug, slug)))
            .returning({ title: wikiPages.title });
          if (page) {
            await appendLog(tx, {
              officeId,
              action: "delete",
              slug,
              title: page.title,
              actor: { userId: user.id },
            });
          }
          return page;
        });
        return deleted ? c.body(null, 204) : c.json(pageNotFound, 404);
      })
      .get(
        "/:officeId/wiki/pages/:slug/related",
        validate("param", wikiSlugParamSchema),
        async (c) => {
          const { officeId, slug } = c.req.valid("param");
          if (!(await access(currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          if (!(await findPageRow(db, officeId, slug))) {
            return c.json(pageNotFound, 404);
          }
          return c.json(await relatedPages(db, officeId, slug));
        },
      )
      .get(
        "/:officeId/wiki/pages/:slug/revisions",
        validate("param", wikiSlugParamSchema),
        async (c) => {
          const { officeId, slug } = c.req.valid("param");
          if (!(await access(currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          const page = await findPageRow(db, officeId, slug);
          return page ? c.json(await listRevisions(db, page.id)) : c.json(pageNotFound, 404);
        },
      )
      .get(
        "/:officeId/wiki/pages/:slug/revisions/:revision",
        validate("param", wikiRevisionParamSchema),
        async (c) => {
          const { officeId, slug, revision } = c.req.valid("param");
          if (!(await access(currentUser(c), officeId))) {
            return c.json(officeNotFound, 404);
          }
          const page = await findPageRow(db, officeId, slug);
          if (!page) {
            return c.json(pageNotFound, 404);
          }
          const found = await getRevision(db, page.id, revision);
          return found ? c.json(found) : c.json(revisionNotFound, 404);
        },
      )
      // Restoring saves the old content as a new revision, so nothing is lost (R-MEM-6).
      .post(
        "/:officeId/wiki/pages/:slug/revisions/:revision/restore",
        validate("param", wikiRevisionParamSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, slug, revision } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const current = await findPageRow(db, officeId, slug);
          if (!current) {
            return c.json(pageNotFound, 404);
          }
          const old = await getRevision(db, current.id, revision);
          if (!old) {
            return c.json(revisionNotFound, 404);
          }
          const actor = { userId: user.id };
          const saved = await db.transaction(async (tx) => {
            const page = await savePageRevision(
              tx,
              current,
              {
                title: old.title,
                section: old.section,
                type: old.type,
                content: old.content,
                sources: old.sources,
                status: old.status,
                verifiedOn: old.verifiedOn,
              },
              actor,
              `Restored revision ${revision}`,
            );
            if (page) {
              await appendLog(tx, {
                officeId,
                action: "restore",
                slug,
                title: page.title,
                detail: `revision ${revision}`,
                actor,
              });
            }
            return page;
          });
          return saved ? c.json(await getPage(db, officeId, slug)) : c.json(revisionConflict, 409);
        },
      )
      .get("/:officeId/wiki/sources", validate("param", wikiOfficeParamSchema), async (c) => {
        const { officeId } = c.req.valid("param");
        if (!(await access(currentUser(c), officeId))) {
          return c.json(officeNotFound, 404);
        }
        return c.json(await listSources(db, officeId));
      })
      // Documents are stored as they are; the chosen colleague reads (with OCR when needed) and
      // files them into the wiki in the background (R-MEM-3).
      .post(
        "/:officeId/wiki/sources",
        bodyLimit({ maxSize: IMPORT_BODY_LIMIT }),
        validate("param", wikiOfficeParamSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const body = await c.req.parseBody({ all: true });
          const colleagueId = typeof body.colleagueId === "string" ? body.colleagueId : "";
          const problem = await colleagueProblem(user, officeId, colleagueId);
          if (problem) {
            return problem === "invalid"
              ? c.json(invalidColleague, 400)
              : c.json(needsProfile, 409);
          }
          const files = [body.files].flat().filter((item): item is File => item instanceof File);
          if (files.length === 0) {
            return c.json(noFiles, 400);
          }

          const rejected: WikiSourceUploadResult["rejected"] = [];
          const ids: string[] = [];
          const hashes = new Set<string>();
          for (const file of files) {
            const format = detectDocumentFormat(file.name, file.type || null);
            if (!format) {
              rejected.push({ fileName: file.name, reason: "unsupported_format" });
              continue;
            }
            if (file.size > WIKI_DOCUMENT_MAX_BYTES) {
              rejected.push({ fileName: file.name, reason: "too_large" });
              continue;
            }
            const data = Buffer.from(await file.arrayBuffer());
            const sha256 = createHash("sha256").update(data).digest("hex");
            const [existing] = await db
              .select({ id: wikiSources.id })
              .from(wikiSources)
              .where(and(eq(wikiSources.officeId, officeId), eq(wikiSources.sha256, sha256)))
              .limit(1);
            if (existing || hashes.has(sha256)) {
              rejected.push({ fileName: file.name, reason: "duplicate" });
              continue;
            }
            hashes.add(sha256);
            const [row] = await db
              .insert(wikiSources)
              .values({
                officeId,
                fileName: file.name,
                format,
                mimeType: file.type || null,
                sizeBytes: file.size,
                sha256,
                data,
                title: file.name.replace(/\.[^.]+$/, "") || file.name,
                colleagueId,
                uploadedByUserId: user.id,
              })
              .returning({ id: wikiSources.id });
            if (row) {
              ids.push(row.id);
            }
          }
          const accepted = (await listSources(db, officeId)).filter((item) =>
            ids.includes(item.id),
          );
          return c.json({ accepted, rejected } satisfies WikiSourceUploadResult, 201);
        },
      )
      .post(
        "/:officeId/wiki/sources/:id/retry",
        validate("param", wikiSourceParamSchema),
        async (c) => {
          const { officeId, id } = c.req.valid("param");
          const found = await access(currentUser(c), officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const [row] = await db
            .update(wikiSources)
            // Retrying reads the document again, e.g. after enabling a vision model.
            .set({
              status: "queued",
              stage: null,
              progress: null,
              content: null,
              error: null,
              errorCode: null,
              outcome: null,
              finishedAt: null,
            })
            .where(
              and(
                eq(wikiSources.id, id),
                eq(wikiSources.officeId, officeId),
                inArray(wikiSources.status, ["done", "error"]),
              ),
            )
            .returning({ id: wikiSources.id });
          if (!row) {
            return c.json(sourceNotFound, 404);
          }
          const [source] = await listSources(db, officeId, id);
          return c.json(source);
        },
      )
      // Removing a document keeps the pages written from it, unless cascade=true removes what
      // was written only from it (R-MEM).
      .delete(
        "/:officeId/wiki/sources/:id",
        validate("param", wikiSourceParamSchema),
        validate("query", wikiSourceDeleteQuerySchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId, id } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          const [source] = await db
            .select({ id: wikiSources.id, fileName: wikiSources.fileName })
            .from(wikiSources)
            .where(
              and(
                eq(wikiSources.id, id),
                eq(wikiSources.officeId, officeId),
                inArray(wikiSources.status, ["queued", "done", "error"]),
              ),
            )
            .limit(1);
          if (!source) {
            return c.json(sourceNotFound, 404);
          }
          if (c.req.valid("query").cascade === "true") {
            return c.json(await deleteSourceWithPages(db, officeId, source, { userId: user.id }));
          }
          await db.delete(wikiSources).where(eq(wikiSources.id, source.id));
          return c.body(null, 204);
        },
      )
      .post(
        "/:officeId/wiki/import",
        bodyLimit({ maxSize: IMPORT_BODY_LIMIT }),
        validate("param", wikiOfficeParamSchema),
        validate("json", wikiImportSchema),
        async (c) => {
          const user = currentUser(c);
          const { officeId } = c.req.valid("param");
          const found = await access(user, officeId);
          if (!found) {
            return c.json(officeNotFound, 404);
          }
          if (!found.canEdit) {
            return c.json(editForbidden, 403);
          }
          return c.json(await importWiki(db, officeId, c.req.valid("json"), { userId: user.id }));
        },
      )
  );
}
