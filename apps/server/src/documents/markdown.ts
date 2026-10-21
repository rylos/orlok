export const MAX_TABLE_ROWS = 2_000;
export const MAX_TABLE_COLUMNS = 50;

/** Intermediate result of a format-specific converter, before normalization. */
export type Conversion = { markdown: string; title?: string | undefined; truncated?: boolean };

export type TableResult = { markdown: string; truncated: boolean };

const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s/;

/** Joins Markdown blocks with blank lines, keeping consecutive list items in one tight list. */
export function joinBlocks(blocks: readonly string[]): string {
  let output = "";
  let previous: string | undefined;
  for (const block of blocks) {
    if (block.trim() === "") continue;
    if (previous !== undefined) {
      output += LIST_ITEM.test(previous) && LIST_ITEM.test(block) ? "\n" : "\n\n";
    }
    output += block;
    previous = block;
  }
  return output;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeCell(value: string): string {
  return value
    .trim()
    .replace(/\r\n?|\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

/**
 * Renders rows as a GFM table with the first row as header. Empty rows and trailing empty
 * columns are dropped; rows and columns beyond the caps are cut with a visible note.
 */
export function markdownTable(rows: readonly (readonly string[])[]): TableResult {
  const filled = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  const kept = filled.slice(0, MAX_TABLE_ROWS + 1);

  let width = 0;
  for (const row of kept) {
    for (let index = row.length - 1; index >= width; index--) {
      if ((row[index] ?? "").trim() !== "") {
        width = index + 1;
        break;
      }
    }
  }
  if (width === 0) return { markdown: "", truncated: false };

  const columns = Math.min(width, MAX_TABLE_COLUMNS);
  const render = (row: readonly string[]) =>
    `| ${Array.from({ length: columns }, (_, index) => escapeCell(row[index] ?? "")).join(" | ")} |`;
  const [header = [], ...body] = kept;
  const lines = [render(header), `|${" --- |".repeat(columns)}`, ...body.map(render)];

  const notes: string[] = [];
  if (filled.length > kept.length) {
    notes.push(
      `_Table cut: only the first ${body.length} of ${filled.length - 1} rows are included._`,
    );
  }
  if (width > columns) {
    notes.push(`_Table cut: only the first ${columns} of ${width} columns are included._`);
  }
  return {
    markdown: [lines.join("\n"), ...notes].join("\n\n"),
    truncated: notes.length > 0,
  };
}

/** Normalizes line endings, trailing spaces and runs of blank lines. */
export function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}
