import type { z } from "zod";
import type { wikiImportSchema, wikiPageCreateSchema, wikiPageUpdateSchema } from "./schemas/wiki";

// Office wiki: the shared memory of an office (R-MEM-1).
export const WIKI_PAGE_TYPES = [
  "overview",
  "entity",
  "concept",
  "procedure",
  "source",
  "synthesis",
  "note",
] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export const WIKI_LOG_ACTIONS = [
  "create",
  "update",
  "delete",
  "restore",
  "import",
  "ingest",
] as const;
export type WikiLogAction = (typeof WIKI_LOG_ACTIONS)[number];

// Whether a page still describes how things are (R-MEM-13). Outdated pages are kept, not deleted:
// search ranks them after the current ones, and they say what replaced them.
export const WIKI_PAGE_STATUSES = ["current", "superseded", "retired", "historical"] as const;
export type WikiPageStatus = (typeof WIKI_PAGE_STATUSES)[number];

export function isWikiPageStatus(value: unknown): value is WikiPageStatus {
  return typeof value === "string" && (WIKI_PAGE_STATUSES as readonly string[]).includes(value);
}

// Groups of words that mean the same thing in the way people ask (R-MEM-4): Italian and English,
// jargon, product names. When a question contains one phrase of a group, the others count as
// alternatives. General IT vocabulary only; each office adds its own (`wikiSynonyms`).
export const WIKI_SEARCH_SYNONYMS: string[][] = [
  ["desktop remoto", "controllo remoto", "rdp", "remote desktop", "vnc", "rustdesk"],
  [
    "togliere la corrente",
    "blackout",
    "mancanza di corrente",
    "interruzione di corrente",
    "power outage",
  ],
  ["spegnimento", "spegnere", "shutdown", "power off"],
  ["riavvio", "riavviare", "reboot", "restart"],
  ["aggiornamento", "aggiornare", "upgrade", "update"],
  ["backup", "copia di sicurezza", "snapshot"],
  ["certificato", "certificati", "ssl", "tls"],
  ["password", "credenziali", "credentials", "accessi"],
  ["indirizzo ip", "indirizzi ip", "ip address"],
  ["accendere da remoto", "wake on lan", "wol"],
  ["stampante", "printer", "stampa"],
  ["posta", "email", "mail"],
  ["rete wifi", "wifi", "wireless", "access point"],
  ["gruppo di continuita", "ups"],
  ["macchina virtuale", "vm", "virtual machine"],
  ["contenitore", "container", "lxc"],
  ["errore", "error", "non funziona", "non va", "non parte"],
  ["lento", "lentezza", "performance", "prestazioni"],
];
export const WIKI_SYNONYMS_MAX = 10_000;

// One group per line, phrases separated by commas; lines starting with # are comments.
export function parseWikiSynonyms(text: string | null | undefined): string[][] {
  return (text ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) =>
      line
        .split(",")
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    )
    .filter((group) => group.length > 1);
}

export const WIKI_SLUG_MAX = 120;
export const WIKI_TITLE_MAX = 200;
export const WIKI_SECTION_MAX = 200;
export const WIKI_CONTENT_MAX = 200_000;
export const WIKI_SOURCES_MAX = 50;
export const WIKI_SOURCE_MAX = 500;
export const WIKI_SUMMARY_MAX = 200;
export const WIKI_IMPORT_FILES_MAX = 2_000;

export const WIKI_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type WikiPageCreateInput = z.input<typeof wikiPageCreateSchema>;
export type WikiPageUpdateInput = z.input<typeof wikiPageUpdateSchema>;
export type WikiImportInput = z.input<typeof wikiImportSchema>;

export function isWikiPageType(value: unknown): value is WikiPageType {
  return typeof value === "string" && (WIKI_PAGE_TYPES as readonly string[]).includes(value);
}

// Lowercase ASCII words joined by hyphens: "Cluster Proxmox (sede)" → "cluster-proxmox-sede".
export function slugify(text: string) {
  const slug = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WIKI_SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "page";
}

// Links between pages are written as [[slug]] or [[Title|label]]; the target is slugified.
export const WIKI_LINK_PATTERN = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;

// Targets linked from a page, ignoring fenced and inline code.
export function extractWikiLinks(content: string) {
  const text = content
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const targets = new Set<string>();
  for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
    targets.add(slugify(match[1] ?? ""));
  }
  return [...targets];
}

export type WikiPageRef = {
  slug: string;
  title: string;
};

// A colleague named in the wiki, with the person it belongs to: colleagues are personal, so two
// can share a name. A deleted colleague keeps its name, so the history still says who wrote what.
export type WikiColleagueRef = {
  name: string;
  owner: string | null;
  deleted: boolean;
};

// Who last changed a page or an entry: a person or an AI colleague.
export type WikiAuthor =
  | { kind: "person"; name: string }
  | ({ kind: "colleague" } & WikiColleagueRef)
  | null;

export type WikiPageSummary = WikiPageRef & {
  section: string | null;
  type: WikiPageType;
  status: WikiPageStatus;
  updatedAt: string;
};

export type WikiPage = WikiPageSummary & {
  id: string;
  content: string;
  sources: string[];
  // Last check against the real systems (YYYY-MM-DD).
  verifiedOn: string | null;
  revision: number;
  updatedBy: WikiAuthor;
  createdAt: string;
  backlinks: WikiPageRef[];
};

export type WikiOverview = {
  office: { id: string; name: string };
  // What the office wiki is for: goals, scope, key questions (given to colleagues).
  purpose: string | null;
  // The office's own synonym groups for search, one per line.
  synonyms: string | null;
  openReviews: number;
  // Administrators and office managers edit; everyone in the office reads (R-MEM-9).
  canEdit: boolean;
  pages: WikiPageSummary[];
};

export type WikiSearchResult = WikiPageSummary & {
  snippet: string;
  // Full-text relevance, comparable only within the same search.
  rank: number;
};

// Where a revision written by a colleague came from: the conversation, with the commands it ran
// there before writing, or the document being filed. Null for people's own edits and for
// revisions written before it was recorded.
export type WikiOrigin = {
  conversationId?: string;
  sourceId?: string;
  opsJobIds?: string[];
};

export type WikiRevisionSummary = {
  revision: number;
  title: string;
  summary: string | null;
  author: WikiAuthor;
  origin: WikiOrigin | null;
  createdAt: string;
};

export type WikiRevision = WikiRevisionSummary & {
  section: string | null;
  type: WikiPageType;
  status: WikiPageStatus;
  verifiedOn: string | null;
  content: string;
  sources: string[];
};

export type WikiLogEntry = {
  id: string;
  action: WikiLogAction;
  slug: string | null;
  title: string;
  detail: string | null;
  author: WikiAuthor;
  createdAt: string;
};

// Tools virtual colleagues use to consult and maintain the wiki (R-MEM-3, R-MEM-4).
export const WIKI_TOOL_NAMES = [
  "wiki_search",
  "wiki_read",
  "wiki_write",
  "wiki_edit",
  "wiki_flag",
  "wiki_review_list",
  "wiki_review_close",
] as const;
export type WikiToolName = (typeof WIKI_TOOL_NAMES)[number];

export function isWikiToolName(value: unknown): value is WikiToolName {
  return typeof value === "string" && (WIKI_TOOL_NAMES as readonly string[]).includes(value);
}

// Knowledge from a conversation that may deserve the wiki (R-MEM-16): proposed to the person, who
// saves it or lets it go. `slug` is the existing page it would update, when search found one.
export type WikiCandidate = { title: string; summary: string; slug: string | null };

// A page created or updated by a virtual colleague.
export type WikiEdit = WikiPageRef & { action: "create" | "update" };

// Documents a virtual colleague reads and turns into wiki pages (R-MEM-3).
export const WIKI_SOURCE_STATUSES = ["queued", "processing", "done", "error"] as const;
export type WikiSourceStatus = (typeof WIKI_SOURCE_STATUSES)[number];

// What a document brought, decided before anything is written (R-MEM-15): only new knowledge,
// changes to what the wiki says, a contradiction with it, or nothing worth writing.
export const WIKI_INGEST_OUTCOMES = ["new", "update", "contradiction", "nothing"] as const;
export type WikiIngestOutcome = (typeof WIKI_INGEST_OUTCOMES)[number];

export const WIKI_DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "doc",
  "odt",
  "rtf",
  "xlsx",
  "xlsm",
  "xls",
  "ods",
  "csv",
  "tsv",
  "pptx",
  "odp",
  "html",
  "htm",
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "tif",
  "tiff",
] as const;
export const WIKI_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const WIKI_DOCUMENT_REJECTIONS = [
  "unsupported_format",
  "no_text",
  "invalid_file",
  "too_large",
  "duplicate",
] as const;
export type WikiDocumentRejection = (typeof WIKI_DOCUMENT_REJECTIONS)[number];

export const WIKI_SOURCE_STAGES = ["extracting", "describing", "filing"] as const;
export type WikiSourceStage = (typeof WIKI_SOURCE_STAGES)[number];

export const WIKI_SOURCE_ERROR_CODES = [
  "no_text",
  "invalid_file",
  "unsupported_format",
  "colleague_unavailable",
  "model_not_configured",
  "provider_error",
  // A monthly spending limit was reached (R-MOD-4); the document can be filed again later.
  "budget_exceeded",
  "internal_error",
] as const;
export type WikiSourceErrorCode = (typeof WIKI_SOURCE_ERROR_CODES)[number];

// How documents are read: local OCR always, plus an optional model with vision for images and
// scanned pages.
export type DocumentSettings = {
  visionProfileId: string | null;
};

// How a colleague looks in the wiki before answering (R-MEM-4). With queryRewrite on, a model
// turns the latest message and the conversation around it into the search: the profile chosen
// here, or the colleague's own model when none is. Off, the message is searched as written.
export type WikiSearchSettings = {
  queryRewrite: boolean;
  queryProfileId: string | null;
};

export type WikiSource = {
  id: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  title: string;
  // The extracted text was cut to the maximum length.
  truncated: boolean;
  status: WikiSourceStatus;
  // While processing: what is happening and, for long documents, how far it got.
  stage: WikiSourceStage | null;
  progress: { done: number; total: number } | null;
  errorCode: WikiSourceErrorCode | null;
  error: string | null;
  // Pages or images read with OCR, and images found in the document.
  ocrUnits: number;
  imageCount: number;
  // Credentials removed from the text before filing (R-SEC-3).
  secretsRemoved: number;
  colleague: ({ id: string } & WikiColleagueRef) | null;
  uploadedBy: string | null;
  edits: WikiEdit[];
  // What the document brought, once filed.
  outcome: WikiIngestOutcome | null;
  createdAt: string;
  finishedAt: string | null;
};

export type WikiSourceUploadResult = {
  accepted: WikiSource[];
  rejected: { fileName: string; reason: WikiDocumentRejection }[];
};

export type WikiImportResult = {
  created: number;
  updated: number;
  unchanged: number;
  // Values that looked like credentials, replaced with [secret removed] before saving (R-SEC).
  secretsRemoved: number;
};

// Knowledge graph of an office wiki (R-MEM-9). Edge weights combine several signals.
export const WIKI_RELEVANCE_WEIGHTS = {
  links: 3,
  sources: 4,
  adamicAdar: 1.5,
  type: 1,
  semantic: 2,
} as const;

export type WikiRelevanceSignals = {
  links: number;
  sources: number;
  adamicAdar: number;
  type: number;
  semantic: number;
};

export type WikiGraphNode = WikiPageRef & {
  type: WikiPageType;
  section: string | null;
  degree: number;
  community: number;
};

export type WikiGraphEdge = {
  source: string;
  target: string;
  weight: number;
  signals: WikiRelevanceSignals;
};

export type WikiCommunity = {
  id: number;
  size: number;
  // Share of possible edges inside the community, 0-1.
  cohesion: number;
  // Title of its most connected page.
  label: string;
};

export const WIKI_SURPRISE_REASONS = ["cross_community", "cross_type", "peripheral_hub"] as const;
export type WikiSurpriseReason = (typeof WIKI_SURPRISE_REASONS)[number];

export type WikiGraphInsights = {
  surprising: { source: string; target: string; score: number; reasons: WikiSurpriseReason[] }[];
  isolated: string[];
  bridges: { slug: string; communities: number }[];
  sparseCommunities: number[];
};

export type WikiGraph = {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  communities: WikiCommunity[];
  insights: WikiGraphInsights;
};

export type WikiRelatedPage = WikiPageRef & {
  type: WikiPageType;
  score: number;
  signals: WikiRelevanceSignals;
};

// Semantic memory: embeddings of wiki pages from an OpenAI-compatible provider (optional).
// builtin: the multilingual model shipped in the server image (default); provider: an
// OpenAI-compatible provider; off: full-text search and links only.
export const EMBEDDING_MODES = ["builtin", "provider", "off"] as const;
export type EmbeddingMode = (typeof EMBEDDING_MODES)[number];

export type EmbeddingSettings = {
  mode: EmbeddingMode;
  providerId: string | null;
  model: string | null;
};

export type EmbeddingOverview = EmbeddingSettings & {
  indexedPages: number;
  totalPages: number;
  builtinAvailable: boolean;
  // Why indexing is not progressing, when it is not: a provider that refuses is otherwise
  // invisible, since pages keep their embeddings from the model used before.
  lastError: { message: string; at: string } | null;
};

export type EmbeddingTestResult = { ok: true; dimensions: number } | { ok: false; message: string };

// Review queue: findings of the wiki lint and questions raised by colleagues, decided by people.
export const WIKI_REVIEW_KINDS = [
  "isolated_page",
  "sparse_community",
  "broken_link",
  "ip_conflict",
  "stale_page",
  "relative_date",
  "missing_entity",
  "contradiction",
  "missing_page",
  "question",
  "check",
  // A change a colleague proposed for someone who cannot edit the wiki (R-MEM-3).
  "proposal",
] as const;
export type WikiReviewKind = (typeof WIKI_REVIEW_KINDS)[number];

// Found by the lint, closed automatically when the problem disappears.
export const WIKI_LINT_KINDS = [
  "isolated_page",
  "sparse_community",
  "broken_link",
  "ip_conflict",
  "stale_page",
  "relative_date",
  "missing_entity",
] as const;

// Raised by a model reading the wiki (R-MEM-14). Not seeing one again does not mean it was fixed,
// so only people close them, and once closed they do not come back.
export const WIKI_MODEL_REVIEW_KINDS = ["check"] as const;

export const WIKI_REVIEW_STATUSES = ["open", "done", "dismissed"] as const;
export type WikiReviewStatus = (typeof WIKI_REVIEW_STATUSES)[number];

// A page change written by a colleague working for someone who may not edit the wiki: kept until
// an office manager applies it, on the revision it was written against, or rejects it.
export type WikiProposal = {
  action: "create" | "update";
  slug: string;
  // The revision the change was made on; null for a new page.
  baseRevision: number | null;
  title: string;
  section: string | null;
  type: WikiPageType;
  content: string;
  sources: string[];
  status?: WikiPageStatus;
  verifiedOn?: string | null;
  summary: string | null;
  origin?: WikiOrigin;
  // The person the colleague was working for.
  proposedFor: string | null;
};

export type WikiReviewItem = {
  id: string;
  kind: WikiReviewKind;
  status: WikiReviewStatus;
  title: string;
  detail: string | null;
  slugs: string[];
  // Page to create for missing pages and broken links.
  suggestedSlug: string | null;
  raisedBy: string | null;
  resolvedBy: string | null;
  proposal: WikiProposal | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type WikiLintResult = { opened: number; closed: number };

// Why a page lost points in its health score (R-MEM-7), worst pages first so they are fixed in
// batches.
export const WIKI_HEALTH_PROBLEMS = [
  "no_links",
  "no_backlinks",
  "no_sources",
  "too_long",
  "stale",
  "relative_dates",
  "outdated_unlinked",
  "open_reviews",
] as const;
export type WikiHealthProblem = (typeof WIKI_HEALTH_PROBLEMS)[number];

export type WikiPageHealth = WikiPageRef & {
  status: WikiPageStatus;
  // 100 is healthy.
  score: number;
  problems: WikiHealthProblem[];
};

export type WikiSourceDeleteResult = { deletedPages: string[]; updatedPages: string[] };
