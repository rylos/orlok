import { type Conversion, collapseWhitespace, joinBlocks, markdownTable } from "./markdown";

// Destinations whose text is metadata, formatting tables or out-of-flow content.
const SKIPPED_DESTINATIONS = new Set([
  "annotation",
  "atnauthor",
  "atnid",
  "author",
  "bkmkend",
  "bkmkstart",
  "category",
  "colorschememapping",
  "colortbl",
  "comment",
  "company",
  "datastore",
  "doccomm",
  "falt",
  "fldinst",
  "filetbl",
  "fonttbl",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "footnote",
  "generator",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "hlinkbase",
  "keywords",
  "latentstyles",
  "listoverridetable",
  "listtable",
  "listtext",
  "mmathPr",
  "nonshppict",
  "objdata",
  "operator",
  "pict",
  "pntext",
  "pntxta",
  "pntxtb",
  "private",
  "revtbl",
  "rsidtbl",
  "sp",
  "subject",
  "themedata",
  "userprops",
  "xmlnstbl",
]);

const SYMBOLS: Record<string, string> = {
  bullet: "•",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
};

type Destination = "body" | "info" | "title" | "stylesheet";

type Group = {
  skip: boolean;
  destination: Destination;
  unicodeSkip: number;
  styleNumber?: number | undefined;
  styleLevel?: number | undefined;
};

/** Minimal RTF reader that keeps paragraphs, outline headings, list items and tables. */
class RtfConverter {
  private readonly blocks: string[] = [];
  private readonly stack: Group[] = [];
  private group: Group = { skip: false, destination: "body", unicodeSkip: 1 };
  private readonly headingStyles = new Map<number, number>();
  private decoder = new TextDecoder("windows-1252");
  private title = "";
  private paragraph = "";
  private headingLevel = 0;
  private listLevel: number | undefined;
  private inTable = false;
  private cellParagraphs: string[] = [];
  private row: string[] = [];
  private rows: string[][] = [];
  private pendingFallback = 0;
  private truncated = false;

  constructor(private readonly source: string) {}

  convert(): Conversion {
    const source = this.source;
    let index = 0;
    while (index < source.length) {
      const char = source.charAt(index);
      if (char === "{") {
        this.stack.push(this.group);
        this.group = { ...this.group };
        this.pendingFallback = 0;
        index++;
      } else if (char === "}") {
        this.closeGroup();
        index++;
      } else if (char === "\\") {
        index = this.readControl(index + 1);
      } else {
        if (char !== "\r" && char !== "\n") this.emitFallbackable(char);
        index++;
      }
    }
    this.endParagraph();
    this.flushTable();
    return {
      markdown: joinBlocks(this.blocks),
      title: collapseWhitespace(this.title) || undefined,
      truncated: this.truncated,
    };
  }

  private closeGroup(): void {
    const closed = this.group;
    const parent = this.stack.pop();
    if (!parent) return;
    if (
      parent.destination === "stylesheet" &&
      closed.styleNumber !== undefined &&
      closed.styleLevel !== undefined
    ) {
      this.headingStyles.set(closed.styleNumber, closed.styleLevel);
    }
    this.group = parent;
    this.pendingFallback = 0;
  }

  private readControl(start: number): number {
    const source = this.source;
    const char = source.charAt(start);
    if (/[a-zA-Z]/.test(char)) {
      let end = start;
      while (/[a-zA-Z]/.test(source.charAt(end))) end++;
      const word = source.slice(start, end);
      const match = /^-?\d+/.exec(source.slice(end, end + 12));
      const parameter = match ? Number(match[0]) : undefined;
      let next = end + (match ? match[0].length : 0);
      if (source.charAt(next) === " ") next++;
      if (word === "bin" && parameter !== undefined) return next + Math.max(parameter, 0);
      this.controlWord(word, parameter);
      return next;
    }
    switch (char) {
      case "'": {
        const byte = Number.parseInt(source.slice(start + 1, start + 3), 16);
        if (!Number.isNaN(byte)) this.emitFallbackable(this.decoder.decode(Uint8Array.of(byte)));
        return start + 3;
      }
      case "*":
        this.group.skip = true;
        break;
      case "\\":
      case "{":
      case "}":
        this.emitFallbackable(char);
        break;
      case "~":
        this.emit(" ");
        break;
      case "_":
        this.emit("-");
        break;
      case "\n":
      case "\r":
        this.endParagraph();
        break;
    }
    return start + 1;
  }

  private controlWord(word: string, parameter: number | undefined): void {
    if (this.group.skip) return;

    const symbol = SYMBOLS[word];
    if (symbol !== undefined) {
      this.emit(symbol);
      return;
    }
    if (word === "u" && parameter !== undefined) {
      this.emit(String.fromCharCode(parameter < 0 ? parameter + 65_536 : parameter));
      this.pendingFallback = this.group.unicodeSkip;
      return;
    }
    if (word === "uc") {
      this.group.unicodeSkip = parameter ?? 1;
      return;
    }

    switch (this.group.destination) {
      case "stylesheet":
        if (word === "s") this.group.styleNumber = parameter;
        else if (word === "outlinelevel") this.group.styleLevel = parameter;
        return;
      case "info":
        if (word === "title") this.group.destination = "title";
        return;
      case "title":
        return;
      case "body":
        this.bodyControlWord(word, parameter);
    }
  }

  private bodyControlWord(word: string, parameter: number | undefined): void {
    switch (word) {
      case "ansicpg":
        try {
          this.decoder = new TextDecoder(`windows-${parameter}`);
        } catch {
          // Unknown code pages keep the Windows-1252 default.
        }
        return;
      case "stylesheet":
        this.group.destination = "stylesheet";
        return;
      case "info":
        this.group.destination = "info";
        return;
      case "par":
      case "sect":
      case "page":
        this.endParagraph();
        return;
      case "line":
      case "tab":
        this.emit(" ");
        return;
      case "pard":
        this.headingLevel = 0;
        this.listLevel = undefined;
        this.inTable = false;
        return;
      case "s": {
        const level = this.headingStyles.get(parameter ?? 0);
        if (level !== undefined) this.headingLevel = level + 1;
        return;
      }
      case "outlinelevel":
        this.headingLevel = (parameter ?? 0) + 1;
        return;
      case "ls":
        this.listLevel ??= 0;
        return;
      case "ilvl":
        this.listLevel = parameter ?? 0;
        return;
      case "intbl":
        this.inTable = true;
        return;
      case "cell":
        this.endCell();
        return;
      case "row":
        this.endRow();
        return;
      default:
        if (SKIPPED_DESTINATIONS.has(word)) this.group.skip = true;
    }
  }

  /** Emits text that may be the ANSI fallback of a preceding `\u` character. */
  private emitFallbackable(text: string): void {
    if (this.pendingFallback > 0) {
      this.pendingFallback--;
      return;
    }
    this.emit(text);
  }

  private emit(text: string): void {
    if (this.group.skip) return;
    if (this.group.destination === "title") this.title += text;
    else if (this.group.destination === "body") this.paragraph += text;
  }

  private endParagraph(): void {
    const text = collapseWhitespace(this.paragraph);
    this.paragraph = "";
    if (this.inTable) {
      if (text) this.cellParagraphs.push(text);
      return;
    }
    this.flushTable();
    if (!text) return;
    if (this.headingLevel > 0) {
      this.blocks.push(`${"#".repeat(Math.min(this.headingLevel, 6))} ${text}`);
    } else if (this.listLevel !== undefined) {
      this.blocks.push(`${"  ".repeat(Math.min(this.listLevel, 8))}- ${text}`);
    } else {
      this.blocks.push(text);
    }
  }

  private endCell(): void {
    const text = collapseWhitespace(this.paragraph);
    this.paragraph = "";
    if (text) this.cellParagraphs.push(text);
    this.row.push(this.cellParagraphs.join(" "));
    this.cellParagraphs = [];
  }

  private endRow(): void {
    if (this.paragraph.trim() !== "" || this.cellParagraphs.length > 0) this.endCell();
    if (this.row.length > 0) this.rows.push(this.row);
    this.row = [];
  }

  private flushTable(): void {
    if (this.rows.length === 0) return;
    const table = markdownTable(this.rows);
    if (table.markdown) this.blocks.push(table.markdown);
    this.truncated ||= table.truncated;
    this.rows = [];
  }
}

export function rtfToMarkdown(data: Uint8Array): Conversion {
  // RTF is 7-bit ASCII with escapes; latin1 maps any stray byte 1:1 without failing.
  const source = new TextDecoder("latin1").decode(data);
  if (!source.trimStart().startsWith("{\\rtf")) throw new Error("Missing RTF header");
  return new RtfConverter(source).convert();
}
