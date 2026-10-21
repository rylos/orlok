import path from "node:path";
import type { ImageCollector } from "./images";
import {
  type Conversion,
  collapseWhitespace,
  joinBlocks,
  MAX_TABLE_COLUMNS,
  markdownTable,
} from "./markdown";
import {
  allText,
  attribute,
  children,
  findAll,
  findFirst,
  parseXml,
  readZip,
  tagName,
  textOf,
  type XmlNode,
  type ZipEntries,
} from "./xml";

type Context = {
  truncated: boolean;
  /** Registers the image a reference points to and returns its Markdown token. */
  image?: ((reference: string) => string | undefined) | undefined;
};

const IMAGE_FILE = /\.(?:png|jpe?g|gif|bmp|webp|tiff?)$/i;

function pushTable(blocks: string[], context: Context, rows: string[][]): void {
  const table = markdownTable(rows);
  if (table.markdown) blocks.push(table.markdown);
  context.truncated ||= table.truncated;
}

function metadataTitle(xml: string | undefined): string | undefined {
  if (xml === undefined) return undefined;
  const node = findFirst(parseXml(xml), "dc:title");
  return (node && collapseWhitespace(allText(children(node)))) || undefined;
}

/** Title from `docProps/core.xml` of an OOXML package; missing metadata is not an error. */
export function ooxmlTitle(data: Uint8Array): string | undefined {
  try {
    return metadataTitle(
      readZip(data, (name) => name === "docProps/core.xml").text("docProps/core.xml"),
    );
  } catch {
    return undefined;
  }
}

/**
 * Registers the images stored in an archive folder when their position in the document is not
 * known (spreadsheets); they end up in the final `## Images` section.
 */
export function collectArchiveImages(
  data: Uint8Array,
  folder: string,
  images: ImageCollector,
): void {
  const files = readZip(
    data,
    () => false,
    (name) => name.startsWith(folder) && IMAGE_FILE.test(name),
  );
  const names = files.names().sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const name of names) images.add(files.bytes(name), "", name);
}

function relationshipTargets(xml: string | undefined, folder: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const relationship of findAll(parseXml(xml ?? ""), "Relationship")) {
    const id = attribute(relationship, "Id");
    const target = attribute(relationship, "Target");
    if (!id || !target || attribute(relationship, "TargetMode") === "External") continue;
    targets.set(
      id,
      target.startsWith("/") ? target.slice(1) : path.posix.normalize(`${folder}/${target}`),
    );
  }
  return targets;
}

// PPTX (DrawingML)

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

function slideNumber(slidePath: string): number {
  return Number(SLIDE_PATH.exec(slidePath)?.[1] ?? 0);
}

function slidePaths(files: ZipEntries): string[] {
  const targets = relationshipTargets(files.text("ppt/_rels/presentation.xml.rels"), "ppt");
  const ordered = findAll(parseXml(files.text("ppt/presentation.xml") ?? ""), "p:sldId")
    .map((slide) => targets.get(attribute(slide, "r:id") ?? ""))
    .filter((slidePath): slidePath is string => slidePath !== undefined && files.has(slidePath));
  if (ordered.length > 0) return ordered;
  // Unusual packages without usable relationships still have numbered slide parts.
  return files
    .names()
    .filter((name) => SLIDE_PATH.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

function drawingText(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    const tag = tagName(node);
    if (tag === "a:t") text += allText(children(node));
    else if (tag === "a:br") text += " ";
    else text += drawingText(children(node));
  }
  return text;
}

function shapeBlocks(shape: XmlNode, blocks: string[]): void {
  const placeholder = findFirst(children(shape), "p:ph");
  // A placeholder without a type is a body placeholder per the OOXML spec.
  const type = placeholder ? (attribute(placeholder, "type") ?? "body") : undefined;
  const isTitle = type === "title" || type === "ctrTitle";
  const isBody = type === "body" || type === "obj";
  const textBody = findFirst(children(shape), "p:txBody");
  if (!textBody) return;

  for (const paragraph of children(textBody)) {
    if (tagName(paragraph) !== "a:p") continue;
    const text = collapseWhitespace(drawingText(children(paragraph)));
    if (!text) continue;
    const properties = children(paragraph).find((node) => tagName(node) === "a:pPr");
    const bullet = properties ? children(properties).map(tagName) : [];
    const level = Number(properties ? attribute(properties, "lvl") : 0) || 0;
    if (isTitle) {
      blocks.push(`### ${text}`);
    } else if (
      bullet.includes("a:buChar") ||
      bullet.includes("a:buAutoNum") ||
      (isBody && !bullet.includes("a:buNone"))
    ) {
      blocks.push(`${"  ".repeat(Math.min(level, 8))}- ${text}`);
    } else {
      blocks.push(text);
    }
  }
}

function drawingBlocks(nodes: readonly XmlNode[], blocks: string[], context: Context): void {
  for (const node of nodes) {
    const tag = tagName(node);
    if (tag === "p:sp") {
      shapeBlocks(node, blocks);
    } else if (tag === "p:pic") {
      const blip = findFirst(children(node), "a:blip");
      const token = blip ? context.image?.(attribute(blip, "r:embed") ?? "") : undefined;
      if (token) blocks.push(token);
    } else if (tag === "a:tbl") {
      const rows = findAll(children(node), "a:tr").map((row) =>
        findAll(children(row), "a:tc").map((cell) =>
          findAll(children(cell), "a:p")
            .map((paragraph) => collapseWhitespace(drawingText(children(paragraph))))
            .filter(Boolean)
            .join(" "),
        ),
      );
      pushTable(blocks, context, rows);
    } else {
      drawingBlocks(children(node), blocks, context);
    }
  }
}

export function pptxToMarkdown(data: Uint8Array, images: ImageCollector): Conversion {
  const files = readZip(
    data,
    (name) =>
      name === "ppt/presentation.xml" ||
      name === "ppt/_rels/presentation.xml.rels" ||
      name === "docProps/core.xml" ||
      (name.startsWith("ppt/slides/") && !IMAGE_FILE.test(name)),
    (name) => name.startsWith("ppt/media/") && IMAGE_FILE.test(name),
  );
  if (!files.has("ppt/presentation.xml")) throw new Error("ppt/presentation.xml is missing");

  const context: Context = { truncated: false };
  const sections: string[] = [];
  slidePaths(files).forEach((slidePath, index) => {
    const label = `slide ${index + 1}`;
    const folder = path.posix.dirname(slidePath);
    const targets = relationshipTargets(
      files.text(`${folder}/_rels/${path.posix.basename(slidePath)}.rels`),
      folder,
    );
    context.image = (id) => {
      const target = targets.get(id);
      return target === undefined ? undefined : images.add(files.bytes(target), label, target);
    };
    const blocks: string[] = [];
    drawingBlocks(parseXml(files.text(slidePath) ?? ""), blocks, context);
    if (blocks.length > 0) sections.push(`## Slide ${index + 1}\n\n${joinBlocks(blocks)}`);
  });
  return {
    markdown: sections.join("\n\n"),
    title: metadataTitle(files.text("docProps/core.xml")),
    truncated: context.truncated,
  };
}

// OpenDocument (ODT, ODP)

function odfInline(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (tagName(node)) {
      case "#text":
        // ODF collapses source whitespace; explicit spaces are encoded as <text:s>.
        text += textOf(node).replace(/\s+/g, " ");
        break;
      case "text:s":
        text += " ".repeat(Math.min(Number(attribute(node, "text:c")) || 1, 100));
        break;
      case "text:tab":
      case "text:line-break":
        text += " ";
        break;
      case "office:annotation":
      case "text:note-citation":
      case "text:tracked-changes":
        break;
      default:
        text += odfInline(children(node));
    }
  }
  return text;
}

function odfParagraphs(node: XmlNode): string {
  return findAll(children(node), ["text:p", "text:h"])
    .map((paragraph) => collapseWhitespace(odfInline(children(paragraph))))
    .filter(Boolean)
    .join(" ");
}

function odfTableRows(table: XmlNode): string[][] {
  return findAll(children(table), "table:table-row").map((row) => {
    const cells: string[] = [];
    for (const cell of children(row)) {
      const tag = tagName(cell);
      if (tag !== "table:table-cell" && tag !== "table:covered-table-cell") continue;
      const text = odfParagraphs(cell);
      const repeat = Number(attribute(cell, "table:number-columns-repeated")) || 1;
      for (let index = 0; index < Math.min(repeat, MAX_TABLE_COLUMNS + 1); index++) {
        cells.push(text);
      }
    }
    return cells;
  });
}

function pushOdfImage(image: XmlNode, blocks: string[], context: Context): void {
  const href = attribute(image, "xlink:href");
  const token = href ? context.image?.(href.replace(/^\.\//, "")) : undefined;
  if (token) blocks.push(token);
}

/** Pushes a paragraph followed by the images anchored inside it. */
function pushOdfParagraph(node: XmlNode, prefix: string, blocks: string[], context: Context): void {
  const text = collapseWhitespace(odfInline(children(node)));
  if (text) blocks.push(`${prefix}${text}`);
  for (const image of findAll(children(node), "draw:image")) pushOdfImage(image, blocks, context);
}

function odfList(list: XmlNode, depth: number, blocks: string[], context: Context): void {
  for (const item of children(list)) {
    const tag = tagName(item);
    if (tag !== "text:list-item" && tag !== "text:list-header") continue;
    for (const child of children(item)) {
      const childTag = tagName(child);
      if (childTag === "text:list") {
        odfList(child, depth + 1, blocks, context);
      } else if (childTag === "text:p" || childTag === "text:h") {
        pushOdfParagraph(child, `${"  ".repeat(Math.min(depth, 8))}- `, blocks, context);
      } else {
        odfBlocks([child], blocks, context);
      }
    }
  }
}

function odfBlocks(nodes: readonly XmlNode[], blocks: string[], context: Context): void {
  for (const node of nodes) {
    switch (tagName(node)) {
      case "text:h": {
        const level = Math.min(Math.max(Number(attribute(node, "text:outline-level")) || 1, 1), 6);
        pushOdfParagraph(node, `${"#".repeat(level)} `, blocks, context);
        break;
      }
      case "text:p":
        pushOdfParagraph(node, "", blocks, context);
        break;
      case "text:list":
        odfList(node, 0, blocks, context);
        break;
      case "table:table":
        pushTable(blocks, context, odfTableRows(node));
        break;
      case "draw:image":
        pushOdfImage(node, blocks, context);
        break;
      case "draw:frame":
        if (attribute(node, "presentation:class") === "title") {
          const text = odfParagraphs(node);
          if (text) blocks.push(`### ${text}`);
        } else {
          odfBlocks(children(node), blocks, context);
        }
        break;
      // Speaker notes, comments, revisions and generated indexes would duplicate or add noise.
      case "presentation:notes":
      case "office:annotation":
      case "text:tracked-changes":
      case "text:table-of-content":
        break;
      default:
        odfBlocks(children(node), blocks, context);
    }
  }
}

function readOdf(data: Uint8Array) {
  const files = readZip(
    data,
    (name) => name === "content.xml" || name === "meta.xml",
    (name) => name.startsWith("Pictures/") && IMAGE_FILE.test(name),
  );
  const content = files.text("content.xml");
  if (content === undefined) throw new Error("content.xml is missing");
  return { files, content: parseXml(content), title: metadataTitle(files.text("meta.xml")) };
}

function odfImageResolver(files: ZipEntries, images: ImageCollector, label: string) {
  return (href: string) => images.add(files.bytes(href), label, href);
}

export function odtToMarkdown(data: Uint8Array, images: ImageCollector): Conversion {
  const { files, content, title } = readOdf(data);
  const body = findFirst(content, "office:text");
  const context: Context = { truncated: false, image: odfImageResolver(files, images, "") };
  const blocks: string[] = [];
  if (body) odfBlocks(children(body), blocks, context);
  return { markdown: joinBlocks(blocks), title, truncated: context.truncated };
}

export function odpToMarkdown(data: Uint8Array, images: ImageCollector): Conversion {
  const { files, content, title } = readOdf(data);
  const presentation = findFirst(content, "office:presentation");
  const context: Context = { truncated: false };
  const sections: string[] = [];
  const pages = presentation ? findAll(children(presentation), "draw:page") : [];
  pages.forEach((page, index) => {
    context.image = odfImageResolver(files, images, `slide ${index + 1}`);
    const blocks: string[] = [];
    odfBlocks(children(page), blocks, context);
    if (blocks.length > 0) sections.push(`## Slide ${index + 1}\n\n${joinBlocks(blocks)}`);
  });
  return { markdown: sections.join("\n\n"), title, truncated: context.truncated };
}
