import {
  slugify,
  WIKI_CONTENT_MAX,
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  WIKI_REVIEW_KINDS,
  WIKI_SECTION_MAX,
  WIKI_SLUG_MAX,
  WIKI_SLUG_PATTERN,
  WIKI_SOURCE_MAX,
  WIKI_SOURCES_MAX,
  WIKI_SUMMARY_MAX,
  WIKI_TITLE_MAX,
  type WikiEdit,
  type WikiOrigin,
  type WikiPageRef,
  type WikiProposal,
  type WikiReviewKind,
  type WikiToolName,
} from "@orlok/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { type WikiPageRow, wikiPages } from "../db/schema";
import { type AgentTool, ToolInputError } from "./agent";
import type { Embedder } from "./embeddings";
import { findLikelySecret } from "./secrets";
import {
  appendLog,
  findPageRow,
  insertPage,
  savePageRevision,
  searchPages,
  type WikiPageFields,
} from "./wiki";
import { checkRewrite, countOccurrences, describeLosses, SHRINK_MIN_SHARE } from "./wiki-guard";
import { retrievePages } from "./wiki-retrieval";
import { listReviewItems, proposeChange, raiseReviewItem, updateReviewItem } from "./wiki-review";

export type WikiToolContext = {
  db: Db;
  officeId: string;
  colleagueId: string;
  // Added to the sources of every page written, e.g. the conversation or the document.
  source: string;
  // Recorded in the office log next to each change.
  logDetail: string;
  onEdit?: (edit: WikiEdit) => void;
  // A page the colleague read in full.
  onRead?: (page: WikiPageRef) => void;
  // Semantic search, when embeddings are configured.
  embedder?: Embedder | null;
  // In a conversation: the person the colleague works with on the review queue. Items are closed
  // in their name, and only when they may edit the wiki.
  reviewer?: { userId: string; canResolve: boolean };
  // Where what the colleague writes comes from, read at each write: the commands of the
  // conversation grow while it answers (R-MEM-3).
  origin?: () => WikiOrigin;
  // Set when the person the colleague works for may not edit the wiki: changes are proposed to
  // the office managers instead of written (R-MEM-3).
  proposeFor?: string;
};

const searchInput = z.object({ query: z.string().trim().min(1).max(200) });
const readInput = z.object({ slug: z.string().trim().min(1).max(WIKI_SLUG_MAX) });
const writeInput = z.object({
  slug: z.string().trim().max(WIKI_SLUG_MAX).regex(WIKI_SLUG_PATTERN).optional(),
  title: z.string().trim().min(1).max(WIKI_TITLE_MAX),
  section: z.string().trim().max(WIKI_SECTION_MAX).nullable().optional(),
  type: z.enum(WIKI_PAGE_TYPES).optional(),
  content: z.string().max(WIKI_CONTENT_MAX),
  sources: z.array(z.string().trim().min(1).max(WIKI_SOURCE_MAX)).max(WIKI_SOURCES_MAX).optional(),
  summary: z.string().trim().max(WIKI_SUMMARY_MAX).optional(),
  base_revision: z.int().min(1).optional(),
  status: z.enum(WIKI_PAGE_STATUSES).optional(),
  verified_on: z.iso.date().nullable().optional(),
  allow_shrink: z.boolean().optional(),
});
const editInput = z.object({
  slug: z.string().trim().min(1).max(WIKI_SLUG_MAX),
  old_text: z.string().min(1).max(WIKI_CONTENT_MAX),
  new_text: z.string().max(WIKI_CONTENT_MAX),
  occurrences: z.int().min(1).max(100).optional(),
  summary: z.string().trim().max(WIKI_SUMMARY_MAX).optional(),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new ToolInputError(`Invalid input (${problems}). Fix it and call the tool again.`);
  }
  return result.data;
}

// One entry per page: a page created and then updated in the same run counts as created.
export function mergeEdits(edits: WikiEdit[]): WikiEdit[] {
  const bySlug = new Map<string, WikiEdit>();
  for (const edit of edits) {
    const previous = bySlug.get(edit.slug);
    bySlug.set(edit.slug, {
      ...edit,
      action: previous?.action === "create" ? "create" : edit.action,
    });
  }
  return [...bySlug.values()];
}

const reviewListInput = z.object({ kind: z.enum(WIKI_REVIEW_KINDS).optional() });
const reviewCloseInput = z.object({
  id: z.uuid(),
  status: z.enum(["done", "dismissed"]),
});

// Most urgent first: what may be wrong, then what is missing, then what is loosely kept.
const REVIEW_ORDER: WikiReviewKind[] = [
  "contradiction",
  "check",
  "ip_conflict",
  "question",
  "stale_page",
  "relative_date",
  "broken_link",
  "missing_page",
  "missing_entity",
  "isolated_page",
  "sparse_community",
];
const REVIEW_LIST_MAX = 30;

const flagInput = z.object({
  kind: z.enum(["contradiction", "missing_page", "question"]),
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(4_000),
  slugs: z.array(z.string().trim().min(1).max(WIKI_SLUG_MAX)).max(20).optional(),
  suggested_slug: z.string().trim().max(WIKI_SLUG_MAX).regex(WIKI_SLUG_PATTERN).optional(),
});

// Rough size of a text in tokens, enough to decide what to read in full.
function estimateTokens(characters: number) {
  return Math.max(1, Math.round(characters / 3.5));
}

// A search result this close to the best one for the title of a new page is reported as similar.
const SIMILAR_TITLE_SCORE = 0.6;

function unique(values: string[]) {
  return [...new Set(values)].slice(0, WIKI_SOURCES_MAX);
}

export function createWikiTools(context: WikiToolContext): AgentTool[] {
  const { db, officeId, colleagueId } = context;
  const actorNow = () => ({ colleagueId, ...(context.origin ? { origin: context.origin() } : {}) });

  function refuseSecrets(text: string) {
    const secret = findLikelySecret(text);
    if (secret) {
      // Saying where lets the colleague fix that line instead of guessing at the whole page.
      throw new ToolInputError(
        `Not saved: line ${secret.line} (title first, then the content) seems to contain ${secret.kind}, starting "${secret.excerpt}". Never store secrets in the wiki: if it is one, write where it is kept instead. If that line is ordinary text, reword it. Then call the tool again.`,
      );
    }
  }

  // Saves a new revision authored by the colleague and logs it. Null when the page changed since
  // it was read.
  async function saveEdit(
    current: WikiPageRow,
    changes: Partial<WikiPageFields>,
    summary: string | null,
  ) {
    const page = await db.transaction(async (tx) => {
      const saved = await savePageRevision(tx, current, changes, actorNow(), summary);
      if (saved) {
        await appendLog(tx, {
          officeId,
          action: "update",
          slug: current.slug,
          title: saved.title,
          detail: context.logDetail,
          actor: actorNow(),
        });
      }
      return saved;
    });
    if (page) {
      context.onEdit?.({ slug: current.slug, title: page.title, action: "update" });
    }
    return page;
  }

  // Nothing is written: the change waits for an office manager, on the revision it was made on.
  async function propose(
    action: "create" | "update",
    slug: string,
    current: WikiPageRow | null,
    changes: Partial<WikiPageFields>,
    summary: string | null,
  ) {
    const proposal: WikiProposal = {
      action,
      slug,
      baseRevision: current?.revision ?? null,
      title: changes.title ?? current?.title ?? slug,
      section: changes.section === undefined ? (current?.section ?? null) : changes.section,
      type: changes.type ?? current?.type ?? "note",
      content: changes.content ?? current?.content ?? "",
      sources: changes.sources ?? current?.sources ?? [context.source],
      ...(changes.status ? { status: changes.status } : {}),
      ...(changes.verifiedOn === undefined ? {} : { verifiedOn: changes.verifiedOn }),
      summary,
      ...(context.origin ? { origin: context.origin() } : {}),
      proposedFor: context.proposeFor ?? null,
    };
    await proposeChange(db, officeId, colleagueId, proposal);
    return `Not written: the person you work for cannot edit the wiki, so this change to [[${slug}]] was proposed to the office managers, who apply or dismiss it from the review queue. Tell the person it is waiting for review. Do not write it again, and remember that the page still shows its old content until it is applied.`;
  }

  // Status and size of pages, so a colleague can tell outdated pages and decide what to read in
  // full (after basic-memory's build_context).
  async function pageDetails(slugs: string[]) {
    const rows = await db
      .select({
        slug: wikiPages.slug,
        status: wikiPages.status,
        characters: sql<number>`length(${wikiPages.content})`,
      })
      .from(wikiPages)
      .where(and(eq(wikiPages.officeId, officeId), inArray(wikiPages.slug, slugs)));
    return new Map(rows.map((row) => [row.slug, { ...row, characters: Number(row.characters) }]));
  }

  // Pages whose title is close to a new page's: a duplicate is easier to avoid than to merge.
  async function similarPages(slug: string, title: string) {
    const found = await searchPages(db, officeId, title, 4);
    return found
      .filter((page) => page.slug !== slug && page.rank >= SIMILAR_TITLE_SCORE)
      .slice(0, 3)
      .map((page) => page.slug);
  }

  const tools: (AgentTool & { name: WikiToolName })[] = [
    {
      name: "wiki_search",
      description:
        "Searches the office wiki by words and meaning, then adds pages related through links and shared sources. Returns slug, title, the page size in tokens, its status when it is not current, and a snippet when available. Search before creating a page, to update the existing one instead.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Words to look for" } },
        required: ["query"],
      },
      async run(input) {
        const { query } = parse(searchInput, input);
        const results = await retrievePages(db, officeId, query, {
          embedder: context.embedder ?? null,
          limit: 12,
        });
        if (results.length === 0) {
          return "No pages found.";
        }
        const details = await pageDetails(results.map((page) => page.slug));
        return results
          .map((page) => {
            const how =
              page.via === "search"
                ? ""
                : page.via === "semantic"
                  ? " (similar meaning)"
                  : " (related through links or sources)";
            const detail = details.get(page.slug);
            const status = detail && detail.status !== "current" ? ` [${detail.status}]` : "";
            const size = detail ? ` ~${estimateTokens(detail.characters)} tokens` : "";
            const snippet = page.snippet ? `\n  ${page.snippet.replace(/\s+/g, " ")}` : "";
            return `- [[${page.slug}]] ${page.title}${status}${how}${size}${snippet}`;
          })
          .join("\n");
      },
    },
    {
      name: "wiki_read",
      description:
        "Reads a wiki page by slug: metadata, current revision and full Markdown content.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string", description: "Slug of the page, as in [[slug]]" } },
        required: ["slug"],
      },
      async run(input) {
        const { slug } = parse(readInput, input);
        const page = await findPageRow(db, officeId, slugify(slug));
        if (!page) {
          throw new ToolInputError(`No page with slug "${slug}". Use wiki_search to find pages.`);
        }
        context.onRead?.({ slug: page.slug, title: page.title });
        return [
          `slug: ${page.slug}`,
          `title: ${page.title}`,
          `section: ${page.section ?? "(none)"}`,
          `type: ${page.type}`,
          `status: ${page.status}`,
          `verified_on: ${page.verifiedOn ?? "(never)"}`,
          `revision: ${page.revision}`,
          `sources: ${page.sources.join("; ") || "(none)"}`,
          "---",
          page.content,
        ].join("\n");
      },
    },
    {
      name: "wiki_write",
      description:
        "Creates a page or replaces the whole content of an existing one. To change a few lines of an existing page, prefer wiki_edit. To update a page with wiki_write, read it first and pass its base_revision; include everything that must remain, since the content is replaced. A rewrite that drops most of a long page is refused unless allow_shrink is set. Every save is kept in the page history.",
      inputSchema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "Existing page to update, or the slug of a new page (lowercase letters, digits and hyphens). Derived from the title when omitted.",
          },
          title: { type: "string" },
          section: {
            type: "string",
            description: "Group of the page, e.g. Network or Servers / Linux",
          },
          type: { type: "string", enum: [...WIKI_PAGE_TYPES] },
          content: {
            type: "string",
            description: "Full Markdown content, with [[slug]] links to related pages",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description:
              "Other sources of the information, e.g. documents or links. The current conversation or document is added automatically.",
          },
          summary: { type: "string", description: "Short description of the change" },
          base_revision: {
            type: "integer",
            description: "Revision returned by wiki_read; required when updating a page",
          },
          status: {
            type: "string",
            enum: [...WIKI_PAGE_STATUSES],
            description:
              "current by default. superseded when another page replaced it (say which, with a link, at the top), retired for something dismissed, historical for a record of the past. Outdated pages are kept, never deleted.",
          },
          verified_on: {
            type: "string",
            description:
              "Date (YYYY-MM-DD) on which the content was checked against the real systems, e.g. after reading a configuration or running a command. Leave out otherwise.",
          },
          allow_shrink: {
            type: "boolean",
            description:
              "Set only when removing most of the page is intended; say why in the summary.",
          },
        },
        required: ["title", "content"],
      },
      async run(input) {
        const data = parse(writeInput, input);
        refuseSecrets([data.title, data.content, ...(data.sources ?? [])].join("\n"));

        const slug = data.slug ?? slugify(data.title);
        const current = await findPageRow(db, officeId, slug);
        const summary = data.summary || null;
        const marks = {
          ...(data.status ? { status: data.status } : {}),
          ...(data.verified_on === undefined ? {} : { verifiedOn: data.verified_on }),
        };

        if (!current) {
          const fields: WikiPageFields = {
            title: data.title,
            section: data.section || null,
            type: data.type ?? "note",
            content: data.content,
            sources: unique([...(data.sources ?? []), context.source]),
            ...marks,
          };
          if (context.proposeFor !== undefined) {
            return propose("create", slug, null, fields, summary);
          }
          const page = await db.transaction(async (tx) => {
            const created = await insertPage(tx, officeId, slug, fields, actorNow(), summary);
            await appendLog(tx, {
              officeId,
              action: "create",
              slug,
              title: created.title,
              detail: context.logDetail,
              actor: actorNow(),
            });
            return created;
          });
          context.onEdit?.({ slug, title: page.title, action: "create" });
          const similar = await similarPages(slug, data.title);
          return [
            `Created [[${slug}]] "${page.title}" (revision ${page.revision}).`,
            similar.length > 0
              ? `Existing pages with a similar title: ${similar.map((item) => `[[${item}]]`).join(", ")}. If one covers the same topic, merge this page into it and mark this one superseded.`
              : null,
          ]
            .filter(Boolean)
            .join("\n");
        }

        const conflict = new ToolInputError(
          `Not saved: page [[${slug}]] already exists at revision ${current.revision}. Read it with wiki_read, merge your changes into its current content and call wiki_write again with base_revision ${current.revision}.`,
        );
        if (data.base_revision !== current.revision) {
          throw conflict;
        }
        const check = checkRewrite(current.content, data.content);
        if (check.shrunk && !data.allow_shrink) {
          throw new ToolInputError(
            `Not saved: the new content of [[${slug}]] is ${data.content.length} characters against ${current.content.length}, less than ${Math.round(SHRINK_MIN_SHARE * 100)}%. Content was probably lost. To change part of the page use wiki_edit; to mark old information outdated, keep it and mark it instead of deleting it. If removing it is intended, call wiki_write again with allow_shrink and say why in the summary.`,
          );
        }
        const changes = {
          title: data.title,
          content: data.content,
          ...(data.section === undefined ? {} : { section: data.section || null }),
          ...(data.type ? { type: data.type } : {}),
          sources: unique([...(data.sources ?? current.sources), context.source]),
          ...marks,
        };
        if (context.proposeFor !== undefined) {
          return propose("update", slug, current, changes, summary);
        }
        const page = await saveEdit(current, changes, summary);
        if (!page) {
          throw conflict;
        }
        return [
          `Updated [[${slug}]] "${page.title}" (revision ${page.revision}).`,
          describeLosses(check)?.concat(
            " If that was not intended, put them back with wiki_edit or wiki_write.",
          ) ?? null,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "wiki_edit",
      description:
        "Changes part of an existing page: replaces old_text with new_text, copied exactly from wiki_read. Saved only when old_text appears exactly as many times as occurrences (1 by default), so nothing else is touched. Use it for corrections, additions and marking a passage as superseded, instead of rewriting the whole page.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Slug of the page, as in [[slug]]" },
          old_text: {
            type: "string",
            description:
              "Text to replace, exactly as it is in the page, with enough context to be unique",
          },
          new_text: { type: "string", description: "Replacement text; empty to remove old_text" },
          occurrences: {
            type: "integer",
            description: "How many times old_text appears and must be replaced; 1 by default",
          },
          summary: { type: "string", description: "Short description of the change" },
        },
        required: ["slug", "old_text", "new_text"],
      },
      async run(input) {
        const data = parse(editInput, input);
        refuseSecrets(data.new_text);
        const current = await findPageRow(db, officeId, slugify(data.slug));
        if (!current) {
          throw new ToolInputError(
            `No page with slug "${data.slug}". Use wiki_search to find pages, or wiki_write to create one.`,
          );
        }
        const expected = data.occurrences ?? 1;
        const found = countOccurrences(current.content, data.old_text);
        if (found !== expected) {
          throw new ToolInputError(
            found === 0
              ? `Not saved: old_text does not appear in [[${current.slug}]] (revision ${current.revision}). Read the page again with wiki_read and copy the text exactly, spaces and line breaks included.`
              : `Not saved: old_text appears ${found} times in [[${current.slug}]], not ${expected}. Include more of the surrounding text to make it unique, or set occurrences to ${found} to replace all of them.`,
          );
        }
        const content = current.content.split(data.old_text).join(data.new_text);
        if (context.proposeFor !== undefined) {
          return propose(
            "update",
            current.slug,
            current,
            { content, sources: unique([...current.sources, context.source]) },
            data.summary || null,
          );
        }
        const page = await saveEdit(
          current,
          { content, sources: unique([...current.sources, context.source]) },
          data.summary || null,
        );
        if (!page) {
          throw new ToolInputError(
            `Not saved: [[${current.slug}]] changed in the meantime. Read it again and repeat the edit.`,
          );
        }
        return [
          `Updated [[${current.slug}]] "${page.title}" (revision ${page.revision}).`,
          describeLosses(checkRewrite(current.content, content)),
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "wiki_flag",
      description:
        "Raises an item in the review queue of the people who manage the wiki, for what needs human judgment: information that contradicts a page or another source, an important topic that deserves a page you cannot write from the material, or a question you cannot resolve. Do not use it for what you can fix yourself.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["contradiction", "missing_page", "question"] },
          title: { type: "string", description: "Short summary" },
          detail: {
            type: "string",
            description: "What the issue is and why it matters, citing pages as [[slug]]",
          },
          slugs: { type: "array", items: { type: "string" }, description: "Pages involved" },
          suggested_slug: { type: "string", description: "For missing pages: the slug to use" },
        },
        required: ["kind", "title", "detail"],
      },
      async run(input) {
        const data = parse(flagInput, input);
        const secret = findLikelySecret(`${data.title}\n${data.detail}`);
        if (secret) {
          throw new ToolInputError(
            `Not raised: line ${secret.line} seems to contain ${secret.kind}, starting "${secret.excerpt}". Describe the issue without it, or reword that line if it is ordinary text.`,
          );
        }
        await raiseReviewItem(db, officeId, {
          kind: data.kind,
          key: null,
          title: data.title,
          detail: data.detail,
          slugs: data.slugs ?? [],
          suggestedSlug: data.suggested_slug ?? null,
          colleagueId,
        });
        return "Raised for review by the people who manage the wiki.";
      },
    },
  ];

  const reviewer = context.reviewer;
  if (reviewer) {
    tools.push(
      {
        name: "wiki_review_list",
        description:
          "Lists the open items of the wiki review queue (checks, contradictions, missing or isolated pages, old verifications), most urgent first, with their id, the pages involved and the details. Use it when the person wants help with the review.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...WIKI_REVIEW_KINDS], description: "Only this kind" },
          },
        },
        async run(input) {
          const { kind } = parse(reviewListInput, input);
          const items = (await listReviewItems(db, officeId, "open"))
            .filter((item) => !kind || item.kind === kind)
            .sort((x, y) => REVIEW_ORDER.indexOf(x.kind) - REVIEW_ORDER.indexOf(y.kind));
          if (items.length === 0) {
            return "The review queue is empty.";
          }
          const shown = items
            .slice(0, REVIEW_LIST_MAX)
            .map((item) =>
              [
                `- id ${item.id} · ${item.kind} · ${item.title}`,
                item.slugs.length > 0
                  ? `  pages: ${item.slugs.map((slug) => `[[${slug}]]`).join(", ")}`
                  : null,
                item.suggestedSlug ? `  page to create: ${item.suggestedSlug}` : null,
                item.detail ? `  ${item.detail.replace(/\s+/g, " ").slice(0, 600)}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            );
          return [
            `${items.length} open items${items.length > REVIEW_LIST_MAX ? `, the first ${REVIEW_LIST_MAX}` : ""}:`,
            ...shown,
          ].join("\n");
        },
      },
      {
        name: "wiki_review_close",
        description:
          "Closes an item of the review queue once it is dealt with: done after the wiki was fixed, dismissed when the person decided it is not a problem. Only after the person agreed.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id from wiki_review_list" },
            status: { type: "string", enum: ["done", "dismissed"] },
          },
          required: ["id", "status"],
        },
        async run(input) {
          const { id, status } = parse(reviewCloseInput, input);
          if (!reviewer.canResolve) {
            throw new ToolInputError(
              "Not closed: only administrators and office managers can close review items, and the person you are talking with is neither. Tell them what you fixed, so one of them can close it.",
            );
          }
          const item = await updateReviewItem(db, officeId, id, status, reviewer.userId);
          if (!item) {
            throw new ToolInputError(`No review item with id ${id}. Use wiki_review_list.`);
          }
          return `Closed as ${status}: ${item.kind} · ${item.title}.`;
        },
      },
    );
  }
  return tools;
}
