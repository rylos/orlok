import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DocumentExtractionErrorCode,
  detectDocumentFormat,
  type ExtractionProgress,
  extractDocument,
  MAX_DOCUMENT_CHARS,
  OCR_LANGUAGES_BY_LOCALE,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "./extract";

// OCR starts a Tesseract worker per extraction, which is slower than plain parsing.
const OCR_TIMEOUT_MS = 60_000;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

function extractFixture(fileName: string) {
  return extractDocument({ fileName, data: fixture(fileName) });
}

function extractText(fileName: string, text: string, mimeType?: string) {
  return extractDocument({ fileName, mimeType, data: new TextEncoder().encode(text) });
}

async function expectErrorCode(promise: Promise<unknown>, code: DocumentExtractionErrorCode) {
  await expect(promise).rejects.toMatchObject({ name: "DocumentExtractionError", code });
}

const NORTH_ROW = /\|\s*North\s*\|\s*42\s*\|/;
const LABEL_WITH_OCR = "[image:img-1]\n> Pressure limit 12 bar\n> Replace filter monthly";

describe("plain text formats", () => {
  it("keeps Markdown as is and uses the file name as title", async () => {
    const result = await extractFixture("sample.md");
    expect(result).toMatchObject({
      format: "markdown",
      title: "sample",
      truncated: false,
      ocrUnits: 0,
      images: [],
    });
    expect(result.markdown).toContain("# Quarterly Report");
    expect(result.markdown).toContain("- South region");
  });

  it("strips the BOM, NUL characters, trailing spaces and extra blank lines", async () => {
    const result = await extractFixture("sample.txt");
    expect(result.markdown).toBe("Plain text line one\n\nLine two");

    const withNul = await extractText("log.log", `a${String.fromCharCode(0)}b\r\n\r\n\r\n\r\nc`);
    expect(withNul).toMatchObject({ format: "text", markdown: "ab\n\nc" });
  });

  it("decodes UTF-16 text with a byte order mark", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from("Café", "utf16le"))]);
    const result = await extractDocument({ fileName: "notes.txt", data: utf16 });
    expect(result.markdown).toBe("Café");
  });

  it("keeps structured text such as JSON unchanged", async () => {
    const result = await extractText("config.json", '{\n  "region": "North"\n}\n');
    expect(result).toMatchObject({ format: "json", markdown: '{\n  "region": "North"\n}' });
  });
});

describe("delimited formats", () => {
  it("renders CSV as a Markdown table with escaped pipes", async () => {
    const result = await extractFixture("sample.csv");
    expect(result.format).toBe("csv");
    expect(result.markdown).toContain("| Region | Inspections | Note |");
    expect(result.markdown).toContain("| North | 42 | Line, with comma |");
    expect(result.markdown).toContain("Pipe \\| char");
  });

  it("renders TSV as a Markdown table", async () => {
    const result = await extractFixture("sample.tsv");
    expect(result).toMatchObject({ format: "tsv", truncated: false });
    expect(result.markdown).toMatch(NORTH_ROW);
  });

  it("caps table rows and notes the cut", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => `row ${index},${index}`);
    const result = await extractText("big.csv", ["name,value", ...rows].join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain("| row 1999 | 1999 |");
    expect(result.markdown).not.toContain("| row 2000 |");
    expect(result.markdown).toContain("only the first 2000 of 2500 rows");
  });
});

describe("HTML", () => {
  it("converts headings, lists and tables and reads the title", async () => {
    const result = await extractFixture("sample.html");
    expect(result).toMatchObject({ format: "html", title: "Quarterly Report" });
    expect(result.markdown).toContain("## Overview");
    expect(result.markdown).toMatch(/^-\s+North region$/m);
    expect(result.markdown).toMatch(NORTH_ROW);
  });

  it("drops scripts, styles and inline image data", async () => {
    const html =
      '<style>p{}</style><script>alert("x")</script><p>Hello <img src="data:image/png;base64,AAAA" alt="Logo"></p>';
    const result = await extractText("page.htm", html);
    expect(result.markdown).toBe("Hello [Image: Logo]");
  });
});

describe("word processing formats", () => {
  it("keeps DOCX headings, emphasis, lists and tables", async () => {
    const result = await extractFixture("sample.docx");
    expect(result).toMatchObject({ format: "docx", title: "Quarterly Report", images: [] });
    expect(result.markdown).toContain("# Quarterly Report");
    expect(result.markdown).toContain("## Overview");
    expect(result.markdown).toContain("**three regions**");
    expect(result.markdown).toMatch(/^-\s+North region$/m);
    expect(result.markdown).toMatch(NORTH_ROW);
  });

  it("extracts text from legacy DOC files", async () => {
    const result = await extractFixture("sample.doc");
    expect(result).toMatchObject({ format: "doc", title: "sample" });
    expect(result.markdown).toContain("Overview");
    expect(result.markdown).toContain("North region");
    expect(result.markdown).toContain("Inspections");
  });

  it("keeps ODT headings, lists and tables", async () => {
    const result = await extractFixture("sample.odt");
    expect(result).toMatchObject({ format: "odt", title: "Quarterly Report" });
    expect(result.markdown).toContain("# Quarterly Report");
    expect(result.markdown).toContain("## Overview");
    expect(result.markdown).toContain("covers three regions.");
    expect(result.markdown).toContain("- North region\n- South region");
    expect(result.markdown).toMatch(NORTH_ROW);
  });

  it("keeps RTF outline headings, lists and tables", async () => {
    const result = await extractFixture("sample.rtf");
    expect(result).toMatchObject({ format: "rtf", title: "sample" });
    expect(result.markdown).toContain("# Quarterly Report");
    expect(result.markdown).toContain("## Overview");
    expect(result.markdown).toContain("- North region\n- South region");
    expect(result.markdown).toMatch(NORTH_ROW);
  });

  it("reads the RTF info title and Unicode escapes", async () => {
    const rtf =
      "{\\rtf1\\ansi{\\info{\\title Menu \\u8364?}}{\\fonttbl{\\f0 Arial;}}Caf\\'e9 \\u8364?5\\par}";
    const result = await extractText("menu.rtf", rtf);
    expect(result).toMatchObject({ title: "Menu €", markdown: "Café €5" });
  });
});

describe("PDF", () => {
  it("separates pages with a blank line and reads the metadata title", async () => {
    const result = await extractFixture("sample.pdf");
    expect(result).toMatchObject({
      format: "pdf",
      title: "Two Page Manual",
      markdown: "First page heading\n\nSecond page body",
      ocrUnits: 0,
      images: [],
    });
  });

  it("reports PDFs without a text layer or recognizable text as no_text", async () => {
    await expectErrorCode(extractFixture("blank.pdf"), "no_text");
  });
});

describe("spreadsheets", () => {
  it.each(["sample.xlsx", "sample.xls", "sample.ods"])(
    "renders one section per non-empty sheet for %s",
    async (fileName) => {
      const result = await extractFixture(fileName);
      expect(result.title).toBe("Inspection Workbook");
      expect(result.markdown).toMatch(/^## Inspections\n\n\| Region \| Inspections \| Passed \|/);
      expect(result.markdown).toMatch(/\|\s*North\s*\|\s*42\s*\|/);
      expect(result.markdown).toContain("## Notes\n\n| Owner | Marco |");
      expect(result.markdown).not.toContain("## Empty");
    },
  );
});

describe("presentations", () => {
  it.each(["sample.pptx", "sample.odp"])(
    "renders one section per slide for %s",
    async (fileName) => {
      const result = await extractFixture(fileName);
      expect(result.title).toBe("Safety Briefing");
      expect(result.markdown).toMatch(/^## Slide 1\n\n### Safety Briefing/);
      expect(result.markdown).toContain("## Slide 2\n\n### Welcome");
      expect(result.markdown).toContain("- Hard hats required\n- Check the logbook");
      expect(result.markdown).toContain("## Slide 3");
      expect(result.markdown).toContain("Schedule the annual inspection.");
    },
  );
});

describe("OCR of scanned pages and images", () => {
  it(
    "OCRs an image-only PDF page and returns the rendered page",
    async () => {
      const events: ExtractionProgress[] = [];
      const result = await extractDocument({
        fileName: "ocr-scanned.pdf",
        data: fixture("ocr-scanned.pdf"),
        onProgress: (progress) => events.push(progress),
      });
      expect(result.markdown).toMatch(/^\[page:1 ocr\]\n[\s\S]*\n\[\/page\]$/);
      expect(result.markdown).toContain("Elevator serial 7734 passed inspection");
      expect(result.ocrUnits).toBe(1);
      expect(result.images).toHaveLength(1);
      const [page] = result.images;
      expect(page).toMatchObject({ id: "page-1", kind: "page", mimeType: "image/jpeg" });
      expect(page?.context).toBe("page 1");
      expect(page?.width).toBeLessThanOrEqual(1_600);
      expect(page?.ocrConfidence).toBeGreaterThan(80);
      expect(page?.data.byteLength).toBeGreaterThan(0);
      expect(events).toContainEqual({ stage: "text", done: 1, total: 1 });
      expect(events).toContainEqual({ stage: "ocr", done: 1, total: 1 });
    },
    OCR_TIMEOUT_MS,
  );

  it.each([
    ["ocr-text.png", "image/png"],
    ["ocr-text.gif", "image/gif"],
    ["ocr-text.tiff", "image/png"],
  ])(
    "recognizes text in %s",
    async (fileName, mimeType) => {
      const result = await extractDocument({
        fileName,
        data: fixture(fileName),
        ocrLanguages: [OCR_LANGUAGES_BY_LOCALE.en],
      });
      expect(result.format).toBe("image");
      expect(result.markdown).toContain("Invoice number 4821");
      expect(result.markdown).toContain("Due date 30 June 2026");
      expect(result.ocrUnits).toBe(1);
      expect(result.images).toMatchObject([
        { id: "page-1", kind: "page", mimeType, width: 1_000, height: 260 },
      ]);
    },
    OCR_TIMEOUT_MS,
  );

  it(
    "downscales large images to 1600 px on the long side",
    async () => {
      const result = await extractFixture("ocr-wide.png");
      expect(result.markdown).toContain("Wide banner caption");
      expect(result.images).toMatchObject([{ mimeType: "image/png", width: 1_600, height: 333 }]);
    },
    OCR_TIMEOUT_MS,
  );

  it(
    "marks unreadable text as illegible or reports a low confidence",
    async () => {
      const result = await extractFixture("ocr-noisy.jpg");
      const confidence = result.images[0]?.ocrConfidence ?? 0;
      expect(result.markdown.includes("[illegible]") || confidence < 60).toBe(true);
    },
    OCR_TIMEOUT_MS,
  );

  it(
    "rejects images whose header is corrupt",
    async () => {
      await expectErrorCode(extractText("photo.png", "not an image"), "invalid_file");
    },
    OCR_TIMEOUT_MS,
  );

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      extractDocument({
        fileName: "ocr-text.png",
        data: fixture("ocr-text.png"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

describe("embedded images", () => {
  it(
    "places DOCX images where they appear, skipping small icons",
    async () => {
      const result = await extractFixture("ocr-image.docx");
      expect(result.markdown).toContain(LABEL_WITH_OCR);
      expect(result.markdown.indexOf("See the label below.")).toBeLessThan(
        result.markdown.indexOf("[image:img-1]"),
      );
      expect(result.markdown).not.toContain("img-2");
      expect(result.ocrUnits).toBe(1);
      expect(result.images).toMatchObject([
        { id: "img-1", kind: "embedded", mimeType: "image/png", width: 900, height: 260 },
      ]);
      expect(result.images[0]?.ocrText).toContain("Pressure limit 12 bar");
    },
    OCR_TIMEOUT_MS,
  );

  it(
    "places ODT images where they appear",
    async () => {
      const result = await extractFixture("ocr-image.odt");
      expect(result.markdown).toContain(LABEL_WITH_OCR);
      expect(result.markdown).not.toContain("img-2");
      expect(result.images).toHaveLength(1);
    },
    OCR_TIMEOUT_MS,
  );

  it.each(["ocr-image.pptx", "ocr-image.odp"])(
    "places slide images in their slide section for %s",
    async (fileName) => {
      const result = await extractFixture(fileName);
      const slide = result.markdown.indexOf("## Slide 3");
      expect(slide).toBeGreaterThanOrEqual(0);
      expect(result.markdown.indexOf(LABEL_WITH_OCR)).toBeGreaterThan(slide);
      expect(result.images).toMatchObject([{ id: "img-1", context: "slide 3" }]);
    },
    OCR_TIMEOUT_MS,
  );

  it.each(["ocr-image.xlsx", "ocr-image.ods"])(
    "lists spreadsheet images in a final section for %s",
    async (fileName) => {
      const result = await extractFixture(fileName);
      expect(result.markdown).toMatch(/\|\s*Filter\s*\|\s*4\s*\|/);
      expect(result.markdown).toContain(`## Images\n\n${LABEL_WITH_OCR}`);
      expect(result.images).toMatchObject([{ id: "img-1", context: "" }]);
    },
    OCR_TIMEOUT_MS,
  );
});

describe("format detection and errors", () => {
  it("lists supported extensions in lowercase without a dot", () => {
    for (const extension of SUPPORTED_DOCUMENT_EXTENSIONS) {
      expect(extension).toMatch(/^[a-z]+$/);
    }
    expect(SUPPORTED_DOCUMENT_EXTENSIONS).toEqual(
      expect.arrayContaining(["docx", "pdf", "xlsx", "png", "tiff"]),
    );
  });

  it("detects formats synchronously for upload validation", () => {
    expect(detectDocumentFormat("scan.TIFF")).toBe("image");
    expect(detectDocumentFormat("upload", "image/webp")).toBe("image");
    expect(detectDocumentFormat("report.docx", "application/pdf")).toBe("docx");
    expect(detectDocumentFormat("archive.zip", "application/zip")).toBeNull();
    expect(detectDocumentFormat("noextension")).toBeNull();
  });

  it("prefers the extension and falls back to the MIME type", async () => {
    const byExtension = await extractText("DATA.CSV", "a,b\n1,2", "text/plain");
    expect(byExtension.format).toBe("csv");

    const byMimeType = await extractText("upload", "a,b\n1,2", "text/csv; charset=utf-8");
    expect(byMimeType).toMatchObject({ format: "csv", title: "upload" });
  });

  it("rejects unsupported formats", async () => {
    await expectErrorCode(extractText("photo.heic", "binary"), "unsupported_format");
    await expectErrorCode(extractText("archive", "x", "application/zip"), "unsupported_format");
  });

  it("rejects corrupt files as invalid_file", async () => {
    await expectErrorCode(extractFixture("corrupt.docx"), "invalid_file");
    await expectErrorCode(extractText("broken.pdf", "not a pdf"), "invalid_file");
    await expectErrorCode(extractText("broken.pptx", "not a zip"), "invalid_file");
    await expectErrorCode(extractText("broken.rtf", "plain text"), "invalid_file");
  });

  it("rejects documents without text as no_text", async () => {
    await expectErrorCode(extractText("empty.md", "\n\n  \n"), "no_text");
  });

  it("cuts output longer than the character cap", async () => {
    const line = `${"x".repeat(99)}\n`;
    const result = await extractText("long.txt", line.repeat(6_000));
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(MAX_DOCUMENT_CHARS);
    expect(result.markdown.endsWith("x")).toBe(true);
  });
});
