import path from "node:path";
import {
  isWikiPageType,
  slugify,
  WIKI_SECTION_MAX,
  WIKI_SLUG_MAX,
  WIKI_SLUG_PATTERN,
  WIKI_SOURCE_MAX,
  WIKI_SOURCES_MAX,
  WIKI_TITLE_MAX,
  type WikiImportResult,
} from "@orlok/shared";
import { parse as parseYaml } from "yaml";
import type { Db } from "../db/client";
import { redactSecrets } from "./secrets";
import {
  appendLog,
  findPageRow,
  insertPage,
  sameFields,
  savePageRevision,
  type WikiActor,
  type WikiPageFields,
} from "./wiki";

type ImportFile = { path: string; content: string };

type ParsedFile = WikiPageFields & {
  path: string;
  slug: string;
};

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) {
    return { data: {}, body: raw };
  }
  try {
    const data: unknown = parseYaml(match[1] ?? "");
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: raw.slice(match[0].length) };
    }
  } catch {
    // Not valid YAML: keep the block as part of the content.
  }
  return { data: {}, body: raw };
}

function segmentsOf(filePath: string) {
  return filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
}

function stringList(value: unknown) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, WIKI_SOURCE_MAX))
    .slice(0, WIKI_SOURCES_MAX);
}

// Removes a first "# Title" heading that repeats the page title.
function withoutTitleHeading(body: string, title: string) {
  const match = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  return match && match[1]?.toLowerCase() === title.toLowerCase()
    ? body.slice(match[0].length).replace(/^\s*\n/, "")
    : body;
}

// What a link may name a page by: its file (full path from the selected folder, or path inside
// it), its file name alone, its title.
type LinkTargets = {
  byPath: Map<string, ParsedFile>;
  byName: Map<string, ParsedFile | null>;
  byTitle: Map<string, ParsedFile>;
  slugs: Set<string>;
};

// The words of a title or link text, without formatting (Joplin keeps `code` in titles).
function titleKey(text: string) {
  return text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Notion ends every exported file and folder name with the page id.
function withoutNotionId(name: string) {
  return name.replace(/\s+[0-9a-f]{32}$/i, "") || name;
}

// A file name as links name it: no folders, no extension, no Notion id ("Page 1a2b…f.md").
function nameKey(filePath: string) {
  const base = path.posix.basename(filePath).replace(MARKDOWN_EXTENSION, "");
  return titleKey(withoutNotionId(base));
}

function addTarget(targets: LinkTargets, page: ParsedFile, fullPath: string, innerPath: string) {
  targets.slugs.add(page.slug);
  targets.byPath.set(path.posix.normalize(fullPath).toLowerCase(), page);
  targets.byPath.set(path.posix.normalize(innerPath).toLowerCase(), page);
  const name = nameKey(fullPath);
  // A name shared by two files names neither.
  targets.byName.set(name, targets.byName.has(name) ? null : page);
  if (!targets.byTitle.has(titleKey(page.title))) {
    targets.byTitle.set(titleKey(page.title), page);
  }
}

// The page a link target names, the way the common exports write it: relative or from the root
// of the export, with or without ".md", encoded or not, with a #heading, by file name alone
// (Obsidian), with a Notion id, or by title.
function findTarget(targets: LinkTargets, dir: string, target: string) {
  let name = target.replace(/[#?].*$/, "").trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // Kept as written.
  }
  if (!name) {
    return null;
  }
  const withExtension = MARKDOWN_EXTENSION.test(name) ? [name] : [name, `${name}.md`];
  for (const candidate of withExtension) {
    const paths = candidate.startsWith("/")
      ? [candidate.slice(1)]
      : [path.posix.join(dir, candidate), candidate];
    for (const item of paths) {
      const page = targets.byPath.get(path.posix.normalize(item).toLowerCase());
      if (page) {
        return page;
      }
    }
  }
  return targets.byName.get(nameKey(name)) ?? targets.byTitle.get(titleKey(name)) ?? null;
}

// Links between imported notes become wiki links: Markdown links to files and [[wiki links]] by
// file name or title (Obsidian). A note link no export could resolve (Joplin writes "undefined"
// for a note outside the export, or ":/id") is matched by its text against the imported titles,
// and becomes plain text when nothing matches: a link to nowhere only misleads. External links,
// images, embeds and links to files that were not imported are kept.
function rewriteLinks(content: string, dir: string, targets: LinkTargets) {
  const toPage = (page: ParsedFile, label: string) => {
    const text = label.trim();
    return !text || titleKey(text) === titleKey(page.title)
      ? `[[${page.slug}]]`
      : `[[${page.slug}|${text.replaceAll("|", "/")}]]`;
  };
  return content
    .replace(
      /(!?)\[([^\]\n]*)\]\(<([^>\n]+)>(?:\s+"[^"]*")?\)|(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (link, ...groups: (string | undefined)[]) => {
        const image = groups[0] ?? groups[3] ?? "";
        const label = groups[1] ?? groups[4] ?? "";
        const target = groups[2] ?? groups[5] ?? "";
        if (image) {
          return link;
        }
        const byTitle = (fallback: string) => {
          const page = targets.byTitle.get(titleKey(label));
          return page ? toPage(page, label) : fallback;
        };
        if (/^:\/[0-9a-f]{32}/i.test(target) || /(^|\/)undefined$/.test(target)) {
          return byTitle(label);
        }
        // Other schemes (https:, mailto:…) and anchors inside the page.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
          return link;
        }
        const page = findTarget(targets, dir, target);
        if (page) {
          return toPage(page, label);
        }
        return byTitle(link);
      },
    )
    .replace(
      /(!?)\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g,
      (link, embed: string, target: string, label?: string) => {
        if (embed) {
          return link;
        }
        // Already a slug of an imported page: nothing to do.
        if (WIKI_SLUG_PATTERN.test(target) && targets.slugs.has(target)) {
          return link;
        }
        const page = findTarget(targets, dir, target);
        return page ? toPage(page, label ?? "") : link;
      },
    );
}

// Turns a folder of Markdown files into pages: folders become sections, frontmatter provides
// title, type, section, sources and slug when present.
export function parseImportFiles(files: ImportFile[], sectionPrefix: string | null) {
  const markdown = files
    .map((file) => ({ ...file, segments: segmentsOf(file.path) }))
    .filter((file) => file.segments.length > 0 && MARKDOWN_EXTENSION.test(file.path));

  // A selected folder arrives as the first segment of every path: it is not a section.
  const first = markdown[0]?.segments[0];
  const sharedRoot =
    first !== undefined &&
    markdown.every((file) => file.segments.length > 1 && file.segments[0] === first);

  const usedSlugs = new Set<string>();
  const parsed: (ParsedFile & { dir: string })[] = [];
  const targets: LinkTargets = {
    byPath: new Map(),
    byName: new Map(),
    byTitle: new Map(),
    slugs: new Set(),
  };

  for (const file of markdown) {
    const segments = sharedRoot ? file.segments.slice(1) : file.segments;
    const fullPath = file.segments.join("/");
    const relativePath = segments.join("/");
    const folders = segments.slice(0, -1).map(withoutNotionId);
    const { data, body } = splitFrontmatter(file.content);

    const fileTitle = withoutNotionId((segments.at(-1) ?? "").replace(MARKDOWN_EXTENSION, ""));
    const title = (
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : fileTitle
    ).slice(0, WIKI_TITLE_MAX);
    const section =
      [sectionPrefix, typeof data.section === "string" ? data.section.trim() : folders.join(" / ")]
        .filter(Boolean)
        .join(" / ")
        .slice(0, WIKI_SECTION_MAX) || null;

    const requested =
      typeof data.slug === "string" && WIKI_SLUG_PATTERN.test(data.slug)
        ? data.slug
        : slugify(title);
    let slug = requested;
    for (let n = 2; usedSlugs.has(slug); n++) {
      slug = `${requested.slice(0, WIKI_SLUG_MAX - String(n).length - 1)}-${n}`;
    }
    usedSlugs.add(slug);

    const sources = stringList(data.sources);
    const item = {
      path: relativePath,
      dir: file.segments.slice(0, -1).join("/"),
      slug,
      title,
      section,
      type: isWikiPageType(data.type) ? data.type : "note",
      sources: sources.length > 0 ? sources : [relativePath.slice(0, WIKI_SOURCE_MAX)],
      content: withoutTitleHeading(body, title),
    };
    parsed.push(item);
    addTarget(targets, item, fullPath, relativePath);
  }

  return parsed.map(({ dir, ...item }) => ({
    ...item,
    content: rewriteLinks(item.content, dir, targets),
  }));
}

// Imports in one transaction: pages with the same slug get a new revision when they differ.
export async function importWiki(
  db: Db,
  officeId: string,
  input: { section: string | null; files: ImportFile[] },
  actor: WikiActor,
): Promise<WikiImportResult> {
  const pages = parseImportFiles(input.files, input.section);
  const result: WikiImportResult = { created: 0, updated: 0, unchanged: 0, secretsRemoved: 0 };

  await db.transaction(async (tx) => {
    for (const { path: source, slug, ...page } of pages) {
      // Notes often keep passwords next to the configuration (Joplin especially); the wiki is read
      // by everyone in the office and sent to model providers, so they stay out of it.
      const redacted = redactSecrets(page.content);
      result.secretsRemoved += redacted.count;
      const fields = { ...page, content: redacted.text };
      const summary = `Imported from ${source}`.slice(0, 200);
      const existing = await findPageRow(tx, officeId, slug);
      if (!existing) {
        await insertPage(tx, officeId, slug, fields, actor, summary);
        result.created++;
      } else if (sameFields(existing, fields)) {
        result.unchanged++;
      } else {
        await savePageRevision(tx, existing, fields, actor, summary);
        result.updated++;
      }
    }
    await appendLog(tx, {
      officeId,
      action: "import",
      slug: null,
      title: input.section ?? "Markdown import",
      detail: `created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}${result.secretsRemoved ? `, secrets removed ${result.secretsRemoved}` : ""}`,
      actor,
    });
  });

  return result;
}
