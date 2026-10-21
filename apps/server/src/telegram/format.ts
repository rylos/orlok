import type { Nodes, Parents, Root, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { TELEGRAM_MESSAGE_MAX } from "./api";

// Colleagues answer in Markdown, as in the app's chat. Telegram understands only a small HTML
// subset (bold, italic, strikethrough, code, links, quotes), so answers are converted to it:
// headings become bold lines, lists get bullets, and tables become monospace grids when they fit
// a phone screen, one card per row otherwise.

// Characters a phone shows on one monospace line without wrapping.
const TABLE_WIDTH_MAX = 40;

export function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function htmlToText(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

function escapeAttribute(text: string) {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function plain(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") {
    return node.type === "html" ? "" : node.value;
  }
  if (node.type === "break") {
    return " ";
  }
  return "children" in node ? (node.children as Nodes[]).map(plain).join("") : "";
}

function inline(nodes: Nodes[]): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(node: Nodes): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value);
    case "strong":
      return `<b>${inline(node.children)}</b>`;
    case "emphasis":
      return `<i>${inline(node.children)}</i>`;
    case "delete":
      return `<s>${inline(node.children)}</s>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "break":
      return "\n";
    case "link": {
      const label = inline(node.children);
      return /^(https?:|mailto:|tg:)/i.test(node.url)
        ? `<a href="${escapeAttribute(node.url)}">${label || escapeHtml(node.url)}</a>`
        : label;
    }
    case "image":
      return node.alt ? escapeHtml(`[${node.alt}]`) : "";
    // Raw HTML in an answer is shown as written, never interpreted.
    case "html":
      return escapeHtml(node.value);
    default:
      return "children" in node ? inline(node.children as Nodes[]) : escapeHtml(plain(node));
  }
}

function codeBlock(value: string, lang?: string | null) {
  const language = lang && /^[\w+#.-]+$/.test(lang) ? ` class="language-${lang}"` : "";
  return `<pre><code${language}>${escapeHtml(value)}</code></pre>`;
}

function cellWidth(text: string) {
  return [...text].length;
}

function table(node: Table): string {
  const rows = node.children.map((row) => row.children.map((cell) => plain(cell).trim()));
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(0, ...rows.map((row) => cellWidth(row[index] ?? ""))),
  );
  const total = widths.reduce((sum, width) => sum + width, 0) + 3 * Math.max(0, columns - 1);
  if (total <= TABLE_WIDTH_MAX) {
    const align = node.align ?? [];
    const line = (row: string[]) =>
      widths
        .map((width, index) => {
          const value = row[index] ?? "";
          const pad = " ".repeat(width - cellWidth(value));
          return align[index] === "right" ? pad + value : value + pad;
        })
        .join(" │ ")
        .trimEnd();
    const [head, ...body] = rows;
    const separator = widths.map((width) => "─".repeat(width)).join("─┼─");
    return `<pre>${escapeHtml([line(head ?? []), separator, ...body.map(line)].join("\n"))}</pre>`;
  }
  // Too wide for a phone: each row becomes a small card, its first cell as the title.
  const [head = [], ...body] = rows;
  return body
    .map((row) => {
      const [title = "", ...rest] = row;
      const lines = rest
        .map((value, index) => {
          const label = head[index + 1];
          return value ? `${label ? `<i>${escapeHtml(label)}</i>: ` : ""}${escapeHtml(value)}` : "";
        })
        .filter(Boolean);
      return [`<b>${escapeHtml(title)}</b>`, ...lines].join("\n");
    })
    .join("\n\n");
}

function list(node: Extract<RootContent, { type: "list" }>, depth: number): string {
  const indent = "   ".repeat(depth);
  const start = node.start ?? 1;
  return node.children
    .map((item, index) => {
      const marker =
        item.checked === true
          ? "☑"
          : item.checked === false
            ? "☐"
            : node.ordered
              ? `${start + index}.`
              : depth % 2 === 0
                ? "•"
                : "◦";
      const parts = item.children.map((child) =>
        child.type === "list" ? list(child, depth + 1) : block(child, depth + 1).trim(),
      );
      const [first = "", ...rest] = parts;
      return [`${indent}${marker} ${first}`, ...rest].join("\n");
    })
    .join("\n");
}

function block(node: RootContent, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.children);
    case "heading":
      return `<b>${inline(node.children)}</b>`;
    case "code":
      return codeBlock(node.value, node.lang);
    case "blockquote":
      return `<blockquote>${node.children.map((child) => block(child, depth)).join("\n\n")}</blockquote>`;
    case "list":
      return list(node, depth);
    case "table":
      return table(node);
    case "thematicBreak":
      return "──────────";
    case "html":
      return escapeHtml(node.value);
    default:
      return "children" in node ? inline((node as Parents).children as Nodes[]) : "";
  }
}

// Packs blocks into messages under Telegram's limit without cutting a tag in half: a block that
// is too long on its own is cut as plain text (code stays code).
function pack(blocks: { html: string; source: RootContent }[], max: number) {
  const messages: string[] = [];
  let current = "";
  const flush = () => {
    if (current) messages.push(current);
    current = "";
  };
  for (const { html, source } of blocks) {
    if (html.length > max) {
      flush();
      const isCode = source.type === "code";
      const text = isCode ? source.value : plain(source);
      const wrap = (piece: string) =>
        isCode ? codeBlock(piece, (source as { lang?: string | null }).lang) : escapeHtml(piece);
      // Escaping makes the text longer, so pieces are measured once escaped.
      const room = max - wrap("").length;
      let piece = "";
      let size = 0;
      for (const char of text) {
        const grow = escapeHtml(char).length;
        if (size + grow > room) {
          messages.push(wrap(piece));
          piece = "";
          size = 0;
        }
        piece += char;
        size += grow;
      }
      if (piece) messages.push(wrap(piece));
      continue;
    }
    const next = current ? `${current}\n\n${html}` : html;
    if (next.length > max) {
      flush();
      current = html;
    } else {
      current = next;
    }
  }
  flush();
  return messages;
}

export function markdownToTelegram(markdown: string, max = TELEGRAM_MESSAGE_MAX): string[] {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks = tree.children
    .filter((node) => node.type !== "definition")
    .map((node) => ({ html: block(node).trimEnd(), source: node }))
    .filter((item) => item.html.trim());
  return pack(blocks, max);
}
