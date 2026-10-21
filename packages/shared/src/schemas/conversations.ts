import { z } from "zod";
import {
  CHAT_ATTACHMENTS_MAX,
  CONVERSATION_TITLE_MAX,
  MESSAGE_CONTENT_MAX,
} from "../conversations";
import { issue } from "./issue";

export const conversationListQuerySchema = z.object({
  colleagueId: z.uuid(issue("invalid_value")),
});

export const conversationCreateSchema = z.object({
  colleagueId: z.uuid(issue("invalid_value")),
});

export const conversationUpdateSchema = z.object({
  title: z.string().trim().min(1, issue("required")).max(CONVERSATION_TITLE_MAX, issue("too_long")),
});

export const messageCreateSchema = z
  .object({
    content: z.string().trim().max(MESSAGE_CONTENT_MAX, issue("too_long")).default(""),
    attachmentIds: z
      .array(z.uuid(issue("invalid_value")))
      .max(CHAT_ATTACHMENTS_MAX, issue("too_long"))
      .default([]),
  })
  .superRefine((value, context) => {
    if (!value.content && value.attachmentIds.length === 0) {
      context.addIssue({ code: "custom", path: ["content"], message: "required" });
    }
  });

export const attachmentUploadSchema = z.object({
  colleagueId: z.uuid(issue("invalid_value")),
});

export const messageParamSchema = z.object({
  id: z.uuid(issue("invalid_value")),
  messageId: z.uuid(issue("invalid_value")),
});

// A proposal to keep something from the conversation in the wiki (R-MEM-16), by position.
export const wikiCandidateParamSchema = z.object({
  id: z.uuid(issue("invalid_value")),
  index: z.coerce.number().int(issue("invalid_value")).min(0, issue("invalid_value")),
});
