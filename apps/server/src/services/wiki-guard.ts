import { extractWikiLinks } from "@orlok/shared";

// Safeguards on pages rewritten by virtual colleagues (R-MEM-3): a whole-page
// rewrite is where text gets lost without anyone noticing. The history keeps
// every revision, but nobody looks at it unless something tells them to.

// A rewrite of a page this long that keeps less than this share of it is refused unless the
// colleague says the cut is intended.
export const SHRINK_FROM_CHARACTERS = 1_500;
export const SHRINK_MIN_SHARE = 0.7;

const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
// Literal values: addresses (with port), dates, commands and names between backticks. In a
// rewrite they are the first to disappear, and the hardest to notice (idea from MemOS).
const FACT = new RegExp(
  String.raw`\b${IPV4}(?::\d{2,5})?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{4}\b|` +
    "`[^`\\n]{3,80}`",
  "g",
);
const HEADING = /^#{1,6} .+$/gm;

export type RewriteCheck = {
  // The new content is much shorter than the old one.
  shrunk: boolean;
  lostLinks: string[];
  lostHeadings: string[];
  lostFacts: string[];
};

function missing(before: Iterable<string>, after: Iterable<string>) {
  const kept = new Set(after);
  return [...new Set(before)].filter((item) => !kept.has(item));
}

export function checkRewrite(before: string, after: string): RewriteCheck {
  return {
    shrunk:
      before.length >= SHRINK_FROM_CHARACTERS && after.length < before.length * SHRINK_MIN_SHARE,
    lostLinks: missing(extractWikiLinks(before), extractWikiLinks(after)),
    lostHeadings: missing(before.match(HEADING) ?? [], after.match(HEADING) ?? []),
    lostFacts: missing(before.match(FACT) ?? [], after.match(FACT) ?? []),
  };
}

// What a colleague is told after a rewrite that dropped links, headings or values, so it can put
// back what it did not mean to remove. Null when nothing was lost.
export function describeLosses(check: RewriteCheck) {
  const lines: string[] = [];
  const list = (items: string[]) =>
    items
      .slice(0, 12)
      .join(" | ")
      .concat(items.length > 12 ? " …" : "");
  if (check.lostLinks.length > 0) {
    lines.push(`links to ${list(check.lostLinks.map((slug) => `[[${slug}]]`))}`);
  }
  if (check.lostHeadings.length > 0) {
    lines.push(`headings ${list(check.lostHeadings)}`);
  }
  if (check.lostFacts.length > 0) {
    lines.push(`values ${list(check.lostFacts)}`);
  }
  return lines.length > 0 ? `This revision no longer contains: ${lines.join("; ")}.` : null;
}

export function countOccurrences(text: string, needle: string) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = text.indexOf(needle);
  while (from !== -1) {
    count += 1;
    from = text.indexOf(needle, from + needle.length);
  }
  return count;
}
