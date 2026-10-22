import {
  BUDGET_SCOPES,
  CHAT_ATTACHMENT_KINDS,
  CHAT_ROLES,
  COST_STATUSES,
  type CommandClassification,
  CREDENTIAL_KINDS,
  DEFAULT_LOCALE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ERROR_CODES,
  EXEC_MODES,
  HOST_CONNECTIONS,
  HOST_KINDS,
  MCP_TOOL_POLICIES,
  MCP_TRANSPORTS,
  MESSAGE_STATUSES,
  type MessagePart,
  type ModelRates,
  OFFICE_ROLES,
  OPS_JOB_STATUSES,
  OPS_PLAN_STATUSES,
  PROVIDER_BILLINGS,
  PROVIDER_KINDS,
  SHELL_KINDS,
  SUPPORTED_LOCALES,
  THEME_PREFERENCES,
  USAGE_PURPOSES,
  USER_ROLES,
  WIKI_INGEST_OUTCOMES,
  WIKI_LOG_ACTIONS,
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  WIKI_REVIEW_KINDS,
  WIKI_REVIEW_STATUSES,
  WIKI_SOURCE_ERROR_CODES,
  WIKI_SOURCE_STAGES,
  WIKI_SOURCE_STATUSES,
  type WikiCandidate,
  type WikiEdit,
  type WikiOrigin,
  type WikiPageRef,
  type WikiProposal,
} from "@orlok/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  // Preferences shared across all devices (R-UI-3, R-I18N-2).
  themePreference: text("theme_preference", { enum: THEME_PREFERENCES })
    .notNull()
    .default("system"),
  locale: text("locale", { enum: SUPPORTED_LOCALES }).notNull().default(DEFAULT_LOCALE),
  // Notifications about approvals and finished interventions (R-CHAT-7).
  notifyByEmail: boolean("notify_by_email").notNull().default(true),
  notifyByPush: boolean("notify_by_push").notNull().default(true),
  // Telegram notifications, once the person has linked an account (R-CHAT-10).
  notifyByTelegram: boolean("notify_by_telegram").notNull().default(true),
  // Disabled people cannot sign in and their sessions are revoked (R-ADM-4).
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// The cookie holds a random token; the database stores only its SHA-256 hash.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    persistent: boolean("persistent").notNull(),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

// Installation settings (key → JSON value).
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// Model providers (R-MOD-1). The API key is stored encrypted (R-SEC-2).
export const modelProviders = pgTable("model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: PROVIDER_KINDS }).notNull(),
  baseUrl: text("base_url"),
  apiKeyEncrypted: text("api_key_encrypted"),
  enabled: boolean("enabled").notNull().default(true),
  // Per token, or included: local models and subscriptions cost nothing per call (R-MOD-4).
  billing: text("billing", { enum: PROVIDER_BILLINGS }).notNull().default("per_token"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Prices of the models of per-token providers, US dollars per million tokens (R-MOD-4). A price
// applies from when it is saved: the usage ledger keeps the rates each call was charged at.
export const modelPrices = pgTable(
  "model_prices",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    rates: jsonb("rates").$type<ModelRates>().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.model] })],
);

// Model profiles (R-MOD-2): a model and the mode its colleagues run commands in (R-OPS-4). Each
// combination exists once and never changes, only its name does. No profile is the default.
export const modelProfiles = pgTable(
  "model_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    mode: text("mode", { enum: EXEC_MODES }).notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull().default(DEFAULT_MAX_OUTPUT_TOKENS),
    // What the model can read in one request, when known (R-MOD-1). Null: unknown.
    contextWindow: integer("context_window"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("model_profiles_provider_id_idx").on(table.providerId),
    uniqueIndex("model_profiles_combination_idx").on(table.providerId, table.model, table.mode),
  ],
);

// Profiles an administrator granted to a person: the ones their colleagues may use (R-MOD-2).
export const profileGrants = pgTable(
  "profile_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.profileId] }),
    index("profile_grants_profile_id_idx").on(table.profileId),
  ],
);

// Offices group AI colleagues, people and memory (R-ADM-2).
export const offices = pgTable("offices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  // Goals and scope of the office wiki, given to colleagues (R-MEM).
  wikiPurpose: text("wiki_purpose"),
  // The office's own synonym groups for wiki search, one per line (R-MEM-4).
  wikiSynonyms: text("wiki_synonyms"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// People assigned to offices (managed with invitations, R-ADM-4). Administrators work in every
// office and are assigned none.
export const officeMembers = pgTable(
  "office_members",
  {
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: OFFICE_ROLES }).notNull().default("member"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.officeId, table.userId] }),
    index("office_members_user_id_idx").on(table.userId),
  ],
);

// AI colleagues (R-ADM-3), each of one person, who works with it in one of their offices. Without
// a profile its owner is granted, a colleague does not answer (R-MOD-2).
export const colleagues = pgTable(
  "colleagues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    // Private notes of the colleague about working with its owner (R-MEM-2): preferences and
    // working context, kept by the colleague and its owner, never in the office wiki.
    notes: text("notes").notNull().default(""),
    profileId: uuid("profile_id").references(() => modelProfiles.id, { onDelete: "set null" }),
    // Hidden and silent, with its conversations kept.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Deleted colleagues keep only their name and owner, so the wiki and the audit log still say
    // who did what; everything else of theirs is gone.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("colleagues_owner_name_idx")
      .on(table.userId, table.officeId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} is null`),
    index("colleagues_office_idx").on(table.officeId),
  ],
);

// Conversations between a person and a colleague (R-CHAT-2).
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    colleagueId: uuid("colleague_id")
      .notNull()
      .references(() => colleagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    // Older messages summarized to keep the conversation inside the model window (R-MOD-6).
    // The messages themselves are kept: only what the model is given changes.
    summary: text("summary"),
    summaryThroughMessageId: uuid("summary_through_message_id"),
    summaryAt: timestamp("summary_at", { withTimezone: true }),
    // When the conversation was read for knowledge worth keeping in the wiki, and what was found
    // (R-MEM-16). Proposed only to the person who had the conversation, who decides.
    wikiReflectedAt: timestamp("wiki_reflected_at", { withTimezone: true }),
    wikiCandidates: jsonb("wiki_candidates").$type<WikiCandidate[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversations_user_colleague_idx").on(table.userId, table.colleagueId, table.updatedAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: CHAT_ROLES }).notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull().default("complete"),
    errorCode: text("error_code", { enum: ERROR_CODES }),
    // Model that produced an assistant message, kept for audit and cost tracking (R-MOD-4).
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // Wiki pages the colleague used for an assistant message, read or cited (R-MEM-4), and those
    // it was given before answering, kept to check what the search brings.
    wikiPages: jsonb("wiki_pages").$type<WikiPageRef[]>(),
    wikiGiven: jsonb("wiki_given").$type<WikiPageRef[]>(),
    wikiEdits: jsonb("wiki_edits").$type<WikiEdit[]>(),
    // Commands the colleague ran or asked to run while answering (R-OPS).
    opsJobIds: jsonb("ops_job_ids").$type<string[]>(),
    // The answer in order, text and commands alternating (R-CHAT-4). Null on answers stored
    // before it existed, which are shown as their text followed by their commands.
    parts: jsonb("parts").$type<MessagePart[]>(),
    createdAt: createdAt(),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

// Email invitations (R-ADM-4). Like sessions, only the SHA-256 of the token is stored.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: USER_ROLES }).notNull().default("member"),
    locale: text("locale", { enum: SUPPORTED_LOCALES }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("invitations_email_idx").on(table.email)],
);

// One-time links to choose a new password, created by an administrator (R-AUTH-7). Only the
// token's SHA-256 is stored; a new link replaces the previous one and using it removes them all.
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("password_resets_user_id_idx").on(table.userId)],
);

// Offices the invited person joins when accepting.
export const invitationOffices = pgTable(
  "invitation_offices",
  {
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    role: text("role", { enum: OFFICE_ROLES }).notNull().default("member"),
  },
  (table) => [primaryKey({ columns: [table.invitationId, table.officeId] })],
);

// Model profiles the invited person is granted when accepting (R-MOD-2).
export const invitationProfiles = pgTable(
  "invitation_profiles",
  {
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.invitationId, table.profileId] })],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// pgvector without a fixed dimension: each embedding model has its own size.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

// Pages of an office wiki (R-MEM-1). The slug is unique in the office and permanent.
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    section: text("section"),
    type: text("type", { enum: WIKI_PAGE_TYPES }).notNull().default("note"),
    content: text("content").notNull().default(""),
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    // Outdated pages are kept and marked, never deleted (R-MEM-13).
    status: text("status", { enum: WIKI_PAGE_STATUSES }).notNull().default("current"),
    // Last time someone checked the page against the real systems.
    verifiedOn: date("verified_on", { mode: "string" }),
    // The revision last read by the critical review, so unchanged pages are not read again (R-MEM-14).
    reviewedRevision: integer("reviewed_revision"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByColleagueId: uuid("updated_by_colleague_id").references(() => colleagues.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("wiki_pages_office_slug_idx").on(table.officeId, table.slug)],
);

// Every saved version of a page (R-MEM-6).
export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    section: text("section"),
    type: text("type", { enum: WIKI_PAGE_TYPES }).notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources").$type<string[]>().notNull(),
    status: text("status", { enum: WIKI_PAGE_STATUSES }).notNull().default("current"),
    verifiedOn: date("verified_on", { mode: "string" }),
    summary: text("summary"),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorColleagueId: uuid("author_colleague_id").references(() => colleagues.id, {
      onDelete: "set null",
    }),
    // Provenance of a colleague's revision (R-MEM-3): conversation and commands, or document.
    origin: jsonb("origin").$type<WikiOrigin>(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("wiki_revisions_page_revision_idx").on(table.pageId, table.revision)],
);

// Links written in page content, by target slug: the target page may not exist yet.
export const wikiLinks = pgTable(
  "wiki_links",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    targetSlug: text("target_slug").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.targetSlug] }),
    index("wiki_links_target_slug_idx").on(table.targetSlug),
  ],
);

// Append-only log of changes to an office wiki (R-MEM-1).
export const wikiLog = pgTable(
  "wiki_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    action: text("action", { enum: WIKI_LOG_ACTIONS }).notNull(),
    slug: text("slug"),
    title: text("title").notNull(),
    detail: text("detail"),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorColleagueId: uuid("author_colleague_id").references(() => colleagues.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [index("wiki_log_office_created_idx").on(table.officeId, table.createdAt)],
);

// Uploaded documents (the raw sources of the wiki) and their ingest by a colleague (R-MEM-3).
// The extracted text is kept so a document can be processed again and cited.
export const wikiSources = pgTable(
  "wiki_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    format: text("format").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type"),
    // Identical files are imported once per office.
    sha256: text("sha256").notNull(),
    // The original file, so a document can be read again (e.g. after enabling vision).
    data: bytea("data").notNull(),
    title: text("title").notNull(),
    // Extracted Markdown; null until the document has been read.
    content: text("content"),
    truncated: boolean("truncated").notNull().default(false),
    status: text("status", { enum: WIKI_SOURCE_STATUSES }).notNull().default("queued"),
    stage: text("stage", { enum: WIKI_SOURCE_STAGES }),
    progress: jsonb("progress").$type<{ done: number; total: number }>(),
    errorCode: text("error_code", { enum: WIKI_SOURCE_ERROR_CODES }),
    // What the source brought to the wiki, decided before writing; "nothing" is recorded too, so
    // the same source is not analysed again for nothing (R-MEM-15).
    outcome: text("outcome", { enum: WIKI_INGEST_OUTCOMES }),
    ocrUnits: integer("ocr_units").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    // Values that looked like credentials, removed from the text before any model read it.
    secretsRemoved: integer("secrets_removed").notNull().default(0),
    error: text("error"),
    colleagueId: uuid("colleague_id").references(() => colleagues.id, { onDelete: "set null" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    edits: jsonb("edits").$type<WikiEdit[]>().notNull().default([]),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("wiki_sources_office_created_idx").on(table.officeId, table.createdAt),
    index("wiki_sources_status_idx").on(table.status, table.createdAt),
    uniqueIndex("wiki_sources_office_sha256_idx").on(table.officeId, table.sha256),
  ],
);

// Embeddings of the current content of a page (semantic search and graph similarity). A page is
// split into as many pieces as it needs: embedding models take a few hundred words at a time, and
// a long page must be searchable to its last line, not only by its opening.
export const wikiEmbeddings = pgTable(
  "wiki_embeddings",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    // Position of the piece in the page, from 0.
    chunk: integer("chunk").notNull().default(0),
    model: text("model").notNull(),
    embedding: vector("embedding").notNull(),
    // updated_at of the page when it was embedded: older means the embedding is stale.
    pageUpdatedAt: timestamp("page_updated_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.chunk] })],
);

// Review queue of an office wiki. Lint findings carry a key, so they are updated instead of
// duplicated and closed when the problem is gone; dismissed findings are not raised again.
export const wikiReviewItems = pgTable(
  "wiki_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: WIKI_REVIEW_KINDS }).notNull(),
    status: text("status", { enum: WIKI_REVIEW_STATUSES }).notNull().default("open"),
    key: text("key"),
    title: text("title").notNull(),
    detail: text("detail"),
    slugs: jsonb("slugs").$type<string[]>().notNull().default([]),
    suggestedSlug: text("suggested_slug"),
    // Proposals (R-MEM-3): the change, applied only by an office manager.
    proposal: jsonb("proposal").$type<WikiProposal>(),
    raisedByColleagueId: uuid("raised_by_colleague_id").references(() => colleagues.id, {
      onDelete: "set null",
    }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("wiki_review_items_office_key_idx")
      .on(table.officeId, table.key)
      .where(sql`${table.key} is not null`),
    index("wiki_review_items_office_status_idx").on(table.officeId, table.status),
  ],
);

// A person's own credentials (R-OPS-3). Secrets are encrypted with ORLOK_SECRET_KEY and never
// returned by the API.
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: CREDENTIAL_KINDS }).notNull(),
    username: text("username"),
    secretEncrypted: text("secret_encrypted").notNull(),
    passphraseEncrypted: text("passphrase_encrypted"),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("credentials_user_name_idx").on(table.userId, table.name)],
);

// Servers reachable over SSH, one registry for the whole installation (R-OPS-1, R-OPS-2). Names
// are unique whatever their case, since colleagues name hosts in their own words.
export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind", { enum: HOST_KINDS }).notNull(),
    // SSH, or WinRM for Windows (R-OPS-2).
    connection: text("connection", { enum: HOST_CONNECTIONS }).notNull().default("ssh"),
    address: text("address").notNull(),
    port: integer("port").notNull().default(22),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    // Trusted on first use, then enforced.
    hostKey: text("host_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("hosts_name_idx").on(sql`lower(${table.name})`)],
);

// The hosts each credential is used on, with its owner repeated so that a person has at most one
// credential per host: the account a colleague acts as is never the colleague's choice, and it
// cannot fall back to a more powerful one when a command is refused (R-OPS-3).
export const credentialHosts = pgTable(
  "credential_hosts",
  {
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.credentialId, table.hostId] }),
    uniqueIndex("credential_hosts_user_host_idx").on(table.userId, table.hostId),
    index("credential_hosts_host_idx").on(table.hostId),
  ],
);

// Command types one person approved "always" (R-OPS-4): valid with all their
// colleagues, on every host and on the runner. PowerShell types are the same whatever their case.
export const approvedCommandTypes = pgTable(
  "approved_command_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shell: text("shell", { enum: SHELL_KINDS }).notNull(),
    type: text("type").notNull(),
    // Disabled types ask again; one an administrator disabled stays so until they enable it.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledByAdmin: boolean("disabled_by_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("approved_command_types_unique").on(
      table.userId,
      table.shell,
      sql`(case when ${table.shell} = 'powershell' then lower(${table.type}) else ${table.type} end)`,
    ),
  ],
);

// MCP servers of an office (R-OPS-10). Tools are cached with their input schemas.
export type McpToolRecord = {
  name: string;
  title: string | null;
  description: string | null;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
};

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    transport: text("transport", { enum: MCP_TRANSPORTS }).notNull(),
    url: text("url"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    // JSON object of header or environment values, encrypted with ORLOK_SECRET_KEY.
    secretsEncrypted: text("secrets_encrypted"),
    secretNames: jsonb("secret_names").$type<string[]>().notNull().default([]),
    toolPolicy: text("tool_policy", { enum: MCP_TOOL_POLICIES }).notNull().default("readonly_auto"),
    enabled: boolean("enabled").notNull().default(true),
    tools: jsonb("tools").$type<McpToolRecord[]>().notNull().default([]),
    // Tools colleagues are given, by name; null gives them every tool the server offers. A server
    // with hundreds of tools would otherwise fill every prompt with their descriptions.
    allowedTools: jsonb("allowed_tools").$type<string[] | null>(),
    toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("mcp_servers_office_name_idx").on(table.officeId, table.name)],
);

// Plans proposed by colleagues: ordered steps that run as jobs (R-OPS-6).
export const opsPlans = pgTable(
  "ops_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    colleagueId: uuid("colleague_id").references(() => colleagues.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    requestedForUserId: uuid("requested_for_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status", { enum: OPS_PLAN_STATUSES }).notNull(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The results have been given back to the colleague.
    reported: boolean("reported").notNull().default(false),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("ops_plans_office_created_idx").on(table.officeId, table.createdAt)],
);

// Commands requested by colleagues, with their approval and result (R-OPS-5).
export const opsJobs = pgTable(
  "ops_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    colleagueId: uuid("colleague_id").references(() => colleagues.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    requestedForUserId: uuid("requested_for_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    hostId: uuid("host_id").references(() => hosts.id, { onDelete: "set null" }),
    targetKind: text("target_kind", { enum: ["runner", "host", "mcp"] }).notNull(),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, { onDelete: "set null" }),
    // MCP tool calls: the tool and its arguments (the command column holds a readable summary).
    toolName: text("tool_name"),
    toolInput: jsonb("tool_input").$type<Record<string, unknown>>(),
    // Step of a plan (R-OPS-6): steps run in order, each after the previous one succeeded.
    planId: uuid("plan_id").references(() => opsPlans.id, { onDelete: "cascade" }),
    planStep: integer("plan_step"),
    targetName: text("target_name").notNull(),
    shell: text("shell", { enum: SHELL_KINDS }).notNull(),
    command: text("command").notNull(),
    reason: text("reason").notNull().default(""),
    timeoutSeconds: integer("timeout_seconds").notNull().default(120),
    classification: jsonb("classification").$type<CommandClassification>().notNull(),
    status: text("status", { enum: OPS_JOB_STATUSES }).notNull(),
    exitCode: integer("exit_code"),
    output: text("output").notNull().default(""),
    truncated: boolean("truncated").notNull().default(false),
    error: text("error"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The result has been given back to the colleague (in the turn or in a follow-up).
    reported: boolean("reported").notNull().default(false),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("ops_jobs_office_created_idx").on(table.officeId, table.createdAt),
    index("ops_jobs_status_idx").on(table.status),
    index("ops_jobs_plan_idx").on(table.planId, table.planStep),
  ],
);

// Append-only audit log (R-SEC-1): no route updates or deletes it.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorColleagueId: uuid("actor_colleague_id").references(() => colleagues.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [index("audit_events_office_created_idx").on(table.officeId, table.createdAt)],
);

export type CredentialRow = typeof credentials.$inferSelect;
export type HostRow = typeof hosts.$inferSelect;
export type OpsJobRow = typeof opsJobs.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type OpsPlanRow = typeof opsPlans.$inferSelect;
export type ApprovedCommandTypeRow = typeof approvedCommandTypes.$inferSelect;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type WikiSourceRow = typeof wikiSources.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
export type OfficeRow = typeof offices.$inferSelect;
export type ColleagueRow = typeof colleagues.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ModelProviderRow = typeof modelProviders.$inferSelect;
export type ModelProfileRow = typeof modelProfiles.$inferSelect;

// Files attached to chat messages (R-CHAT-3). Uploaded before sending (messageId null) and
// bound to the message when it is sent; unsent ones are removed after a day.
export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    colleagueId: uuid("colleague_id")
      .notNull()
      .references(() => colleagues.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    kind: text("kind", { enum: CHAT_ATTACHMENT_KINDS }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    // Markdown extracted from documents; null for images.
    text: text("text"),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    index("chat_attachments_message_idx").on(table.messageId),
    index("chat_attachments_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export type ChatAttachmentRow = typeof chatAttachments.$inferSelect;

// Browsers subscribed to web push notifications (R-CHAT-7).
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);

// One row per model call the server makes (R-MOD-4): who it was for, what for, the tokens the
// provider reported and what they cost at the prices of that moment. Written, never updated.
export const modelUsage = pgTable(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    colleagueId: uuid("colleague_id").references(() => colleagues.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    purpose: text("purpose", { enum: USAGE_PURPOSES }).notNull(),
    providerId: uuid("provider_id").references(() => modelProviders.id, { onDelete: "set null" }),
    providerName: text("provider_name").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull(),
    costStatus: text("cost_status", { enum: COST_STATUSES }).notNull(),
    // Millionths of a US dollar; null unless priced.
    costMicros: bigint("cost_micros", { mode: "number" }),
    rates: jsonb("rates").$type<ModelRates>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_usage_created_idx").on(table.createdAt),
    index("model_usage_office_created_idx").on(table.officeId, table.createdAt),
    index("model_usage_user_created_idx").on(table.userId, table.createdAt),
  ],
);

// Monthly spending limits (R-MOD-4): the installation (no scope id), an office or a person. The
// months in which the warning and the limit were notified, so each is notified once.
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope", { enum: BUDGET_SCOPES }).notNull(),
    officeId: uuid("office_id").references(() => offices.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    monthlyLimitMicros: bigint("monthly_limit_micros", { mode: "number" }).notNull(),
    warnPercent: integer("warn_percent").notNull(),
    warnedMonth: text("warned_month"),
    exceededMonth: text("exceeded_month"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("budgets_scope_unique").on(table.scope, table.officeId, table.userId).nullsNotDistinct(),
  ],
);

// A person's Telegram account (R-CHAT-10): one per person and one person per Telegram chat. The
// colleague and conversation the chat is talking to now; /new starts another conversation.
export const telegramAccounts = pgTable("telegram_accounts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  chatId: bigint("chat_id", { mode: "number" }).notNull().unique(),
  username: text("username"),
  colleagueId: uuid("colleague_id").references(() => colleagues.id, { onDelete: "set null" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  linkedAt: createdAt(),
});

// Approval requests sent to a Telegram chat with their buttons (R-CHAT-12): once decided anywhere
// — on the web, from Telegram, or cancelled — the message is rewritten with the outcome and
// loses its buttons, so the chat never offers a decision that is already taken.
export const telegramPrompts = pgTable(
  "telegram_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull(),
    jobId: uuid("job_id").references(() => opsJobs.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => opsPlans.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("telegram_prompts_created_idx").on(table.createdAt)],
);

// One-time links to connect a Telegram account, valid 15 minutes; only their SHA-256 is kept.
export const telegramLinkTokens = pgTable("telegram_link_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
