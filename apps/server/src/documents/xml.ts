import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

/** A node in fast-xml-parser's `preserveOrder` output: `{ tag: children, ":@": attributes }`. */
export type XmlNode = Record<string, unknown>;

// Protects against zip bombs; text-bearing parts of real office files are far smaller.
const MAX_REQUIRED_BYTES = 200 * 1024 * 1024;
const MAX_OPTIONAL_BYTES = 100 * 1024 * 1024;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  // Whitespace inside runs is significant in office XML (e.g. "covers <b>three</b>").
  trimValues: false,
});

export class ZipEntries {
  private readonly decoder = new TextDecoder();

  constructor(private readonly entries: Readonly<Record<string, Uint8Array>>) {}

  has(name: string): boolean {
    return Object.hasOwn(this.entries, name);
  }

  names(): string[] {
    return Object.keys(this.entries);
  }

  bytes(name: string): Uint8Array | undefined {
    return this.has(name) ? this.entries[name] : undefined;
  }

  text(name: string): string | undefined {
    const bytes = this.bytes(name);
    return bytes && this.decoder.decode(bytes);
  }
}

/**
 * Reads selected zip entries. Required entries beyond the size budget fail the archive; optional
 * ones (such as embedded images) are skipped instead.
 */
export function readZip(
  data: Uint8Array,
  include: (name: string) => boolean,
  optional: (name: string) => boolean = () => false,
): ZipEntries {
  let requiredBytes = 0;
  let optionalBytes = 0;
  const entries = unzipSync(data, {
    filter: (file) => {
      if (include(file.name)) {
        requiredBytes += file.originalSize;
        if (requiredBytes > MAX_REQUIRED_BYTES) {
          throw new Error("Archive content exceeds the size limit");
        }
        return true;
      }
      if (!optional(file.name) || optionalBytes + file.originalSize > MAX_OPTIONAL_BYTES) {
        return false;
      }
      optionalBytes += file.originalSize;
      return true;
    },
  });
  return new ZipEntries(entries);
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseXml(xml: string): XmlNode[] {
  const result: unknown = parser.parse(xml);
  return Array.isArray(result) ? result.filter(isNode) : [];
}

export function tagName(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ":@") return key;
  }
  return "";
}

export function children(node: XmlNode): XmlNode[] {
  const value = node[tagName(node)];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

export function attribute(node: XmlNode, name: string): string | undefined {
  const attributes = node[":@"];
  if (!isNode(attributes)) return undefined;
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
}

function textValue(node: XmlNode): string {
  const value = node["#text"];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function matches(node: XmlNode, names: string | readonly string[]): boolean {
  const tag = tagName(node);
  return typeof names === "string" ? tag === names : names.includes(tag);
}

/** Depth-first search for the first node with one of the given tags. */
export function findFirst(
  nodes: readonly XmlNode[],
  names: string | readonly string[],
): XmlNode | undefined {
  for (const node of nodes) {
    if (matches(node, names)) return node;
    const found = findFirst(children(node), names);
    if (found) return found;
  }
  return undefined;
}

/** Collects matching nodes in document order without descending into matches. */
export function findAll(
  nodes: readonly XmlNode[],
  names: string | readonly string[],
  found: XmlNode[] = [],
): XmlNode[] {
  for (const node of nodes) {
    if (matches(node, names)) found.push(node);
    else findAll(children(node), names, found);
  }
  return found;
}

export function isText(node: XmlNode): boolean {
  return tagName(node) === "#text";
}

export function textOf(node: XmlNode): string {
  return textValue(node);
}

export function allText(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) text += isText(node) ? textValue(node) : allText(children(node));
  return text;
}
