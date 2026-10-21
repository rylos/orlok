import Papa from "papaparse";
import * as XLSX from "xlsx";
import { type Conversion, MAX_TABLE_ROWS, markdownTable } from "./markdown";

export function delimitedToMarkdown(text: string, delimiter?: string): Conversion {
  // An empty delimiter lets Papa Parse detect ",", ";", tab or pipe (common in European CSV).
  const result = Papa.parse<string[]>(text, {
    delimiter: delimiter ?? "",
    skipEmptyLines: "greedy",
  });
  return markdownTable(result.data);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowCount(range: unknown): number {
  if (typeof range !== "string") return 0;
  const { s, e } = XLSX.utils.decode_range(range);
  return e.r - s.r + 1;
}

export function spreadsheetToMarkdown(data: Uint8Array): Conversion {
  const workbook = XLSX.read(data, {
    type: "array",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    // Stops parsing rows past the cap instead of materializing huge sheets.
    sheetRows: MAX_TABLE_ROWS + 1,
  });

  let truncated = false;
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false })
      .map((row) => row.map(cellText));
    const table = markdownTable(rows);
    if (!table.markdown) continue;

    let markdown = `## ${name}\n\n${table.markdown}`;
    truncated ||= table.truncated;
    const fullRows = rowCount(sheet["!fullref"]);
    if (fullRows > rowCount(sheet["!ref"])) {
      markdown += `\n\n_Sheet cut: only the first ${MAX_TABLE_ROWS + 1} of ${fullRows} rows were read._`;
      truncated = true;
    }
    sections.push(markdown);
  }

  const title = workbook.Props?.Title;
  return {
    markdown: sections.join("\n\n"),
    title: typeof title === "string" ? title.trim() || undefined : undefined,
    truncated,
  };
}
