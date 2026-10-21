import turndownPluginGfm from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";
import { IMAGE_SLOT_SRC_PREFIX, slotToken } from "./images";

type ElementLike = { getAttribute(name: string): string | null };

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});
turndown.use(turndownPluginGfm.gfm);
turndown.remove(["script", "style", "noscript", "template", "title", "head"]);
turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const element = node as unknown as ElementLike;
    const src = element.getAttribute("src") ?? "";
    if (src.startsWith(IMAGE_SLOT_SRC_PREFIX)) {
      // DOCX images collected for OCR; the token becomes `[image:<id>]` once ids are assigned.
      const slot = Number(src.slice(IMAGE_SLOT_SRC_PREFIX.length));
      return Number.isInteger(slot) ? `\n\n${slotToken(slot)}\n\n` : "";
    }
    const alt = (element.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
    // Inline data URIs are megabytes of noise for a language model; keep only real links.
    if (/^https?:\/\//i.test(src)) return `![${alt}](${src})`;
    return alt ? `[Image: ${alt}]` : "";
  },
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
  return title || undefined;
}
