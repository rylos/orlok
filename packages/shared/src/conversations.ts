import type { z } from "zod";
import type { ErrorCode } from "./errors";
import type { ChatRole, TokenUsage } from "./models";
import type {
  conversationCreateSchema,
  conversationUpdateSchema,
  messageCreateSchema,
} from "./schemas/conversations";
import type { WikiCandidate, WikiEdit, WikiPageRef } from "./wiki";

// Conversations between a person and an AI colleague (R-CHAT-2).
export const MESSAGE_STATUSES = ["complete", "stopped", "error"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CONVERSATION_TITLE_MAX = 120;
export const MESSAGE_CONTENT_MAX = 100_000;

// Files attached to a message (R-CHAT-3): images go to the model as images, documents as text.
export const CHAT_ATTACHMENTS_MAX = 10;
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;
export const CHAT_DOCUMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "csv",
  "tsv",
  "pptx",
  "odp",
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "bmp",
  "tif",
  "tiff",
] as const;
export const CHAT_ATTACHMENT_KINDS = ["image", "document"] as const;
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number];

export type ChatAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  // Documents longer than the model context limit are cut.
  truncated: boolean;
};

export type ConversationCreateInput = z.input<typeof conversationCreateSchema>;
export type ConversationUpdateInput = z.input<typeof conversationUpdateSchema>;
export type MessageCreateInput = z.input<typeof messageCreateSchema>;

export type ConversationSummary = {
  id: string;
  colleagueId: string;
  title: string | null;
  updatedAt: string;
};

// A conversation in the list of a colleague's ones: whether a command or a plan in it waits for
// the person's approval, worked out when the list is asked for and never stored.
export type ConversationListItem = ConversationSummary & {
  waiting: boolean;
};

// What an answer is made of, in the order it happened (R-CHAT-4): the text the colleague wrote
// and the commands it stopped to run, so a command card can sit exactly where the answer paused
// for it instead of being piled up at the end. The model already emits text and tool calls in
// order, so nothing has to be measured or guessed: the parts are closed as the events arrive.
export type MessagePart = { type: "text"; text: string } | { type: "job"; jobId: string };

export type ConversationMessage = {
  id: string;
  role: ChatRole;
  content: string;
  // The answer in order. Answers stored before parts existed are rebuilt as their text followed
  // by their commands, which is how they were shown then.
  parts: MessagePart[];
  status: MessageStatus;
  errorCode: ErrorCode | null;
  usage: TokenUsage | null;
  // Wiki pages given to the colleague as context for this answer (R-MEM-4).
  wikiPages: WikiPageRef[];
  // Wiki pages the colleague created or updated while answering (R-MEM-3).
  wikiEdits: WikiEdit[];
  // Commands run or requested while answering (R-OPS).
  opsJobIds: string[];
  attachments: ChatAttachment[];
  createdAt: string;
};

export type Conversation = ConversationSummary & {
  officeId: string;
  // Window of the colleague's model, when known, so the chat can show how full it is (R-MOD-6).
  contextWindow: number | null;
  // Set once the oldest messages have been summarized to keep the conversation inside it.
  compacted: boolean;
  // The colleague is still writing an answer, which the page can follow (R-CHAT-13).
  running: boolean;
  // What the colleague proposes to keep in the wiki, once the conversation went quiet.
  wikiCandidates: WikiCandidate[];
  messages: ConversationMessage[];
};
