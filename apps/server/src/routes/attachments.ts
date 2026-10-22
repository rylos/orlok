import { CHAT_ATTACHMENT_MAX_BYTES, type Me } from "@orlok/shared";
import { attachmentUploadSchema } from "@orlok/shared/schemas";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { currentUser, requireUser } from "../auth/middleware";
import { chatAttachments } from "../db/schema";
import { errorBody } from "../lib/errors";
import { idParamSchema, validate } from "../lib/validation";
import {
  attachmentColumns,
  prepareAttachment,
  toChatAttachment,
} from "../services/chat-attachments";
import { findTalkableColleague, isActive } from "../services/colleagues";
import type { AppEnv, Deps } from "../types";

const attachmentNotFound = errorBody("not_found", "Attachment not found");
const colleagueNotFound = errorBody("not_found", "Colleague not found");
const messages = {
  unsupported_file: "This type of file cannot be attached",
  file_too_large: "The file is too large",
  file_unreadable: "The file could not be read",
} as const;

// Files attached to chat messages (R-CHAT-3), private to the person who uploaded them.
export function attachmentRoutes({ db }: Deps) {
  async function canUseColleague(user: Me, colleagueId: string) {
    const row = await findTalkableColleague(db, user, colleagueId);
    return Boolean(row && isActive(row.colleague));
  }

  async function findOwn(user: Me, id: string) {
    const [row] = await db
      .select(attachmentColumns)
      .from(chatAttachments)
      .where(and(eq(chatAttachments.id, id), eq(chatAttachments.userId, user.id)))
      .limit(1);
    if (!row) {
      return null;
    }
    return (await findTalkableColleague(db, user, row.colleagueId)) ? row : null;
  }

  return (
    new Hono<AppEnv>()
      .use(requireUser)
      // Multipart: `file` and `colleagueId`. Documents are read here so problems show at once.
      .post(
        "/",
        bodyLimit({
          maxSize: CHAT_ATTACHMENT_MAX_BYTES + 1024 * 1024,
          onError: (c) => c.json(errorBody("file_too_large", messages.file_too_large), 413),
        }),
        async (c) => {
          const user = currentUser(c);
          const body = await c.req.parseBody();
          const parsed = attachmentUploadSchema.safeParse({ colleagueId: body.colleagueId });
          if (!parsed.success) {
            return c.json(errorBody("validation_failed", "A valid colleagueId is required"), 400);
          }
          const { colleagueId } = parsed.data;
          if (!(await canUseColleague(user, colleagueId))) {
            return c.json(colleagueNotFound, 404);
          }
          const file = body.file;
          if (!(file instanceof File)) {
            return c.json(errorBody("validation_failed", "A file is required"), 400);
          }
          const prepared = await prepareAttachment({
            fileName: file.name,
            mimeType: file.type || null,
            data: new Uint8Array(await file.arrayBuffer()),
          });
          if ("error" in prepared) {
            return c.json(
              errorBody(prepared.error, messages[prepared.error]),
              prepared.error === "file_too_large" ? 413 : 422,
            );
          }
          const [row] = await db
            .insert(chatAttachments)
            .values({
              userId: user.id,
              colleagueId,
              fileName: file.name.slice(0, 255) || "file",
              mimeType: prepared.mimeType,
              kind: prepared.kind,
              sizeBytes: prepared.data.byteLength,
              data: prepared.data,
              text: prepared.text,
              truncated: prepared.truncated,
            })
            .returning(attachmentColumns);
          if (!row) {
            throw new Error("Attachment insert returned no row");
          }
          return c.json(toChatAttachment(row), 201);
        },
      )
      .get("/:id", validate("param", idParamSchema), async (c) => {
        const row = await findOwn(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(attachmentNotFound, 404);
        }
        const [file] = await db
          .select({ data: chatAttachments.data })
          .from(chatAttachments)
          .where(eq(chatAttachments.id, row.id))
          .limit(1);
        if (!file) {
          return c.json(attachmentNotFound, 404);
        }
        // Images are shown inline; documents are always downloaded, never rendered.
        const image = row.kind === "image";
        return c.body(new Uint8Array(file.data), 200, {
          "Content-Type": image ? row.mimeType : "application/octet-stream",
          "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
          "Cache-Control": "private, max-age=86400",
        });
      })
      // Only attachments not sent yet can be removed.
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const row = await findOwn(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(attachmentNotFound, 404);
        }
        if (row.messageId) {
          return c.json(errorBody("conflict", "The attachment was already sent"), 409);
        }
        await db.delete(chatAttachments).where(eq(chatAttachments.id, row.id));
        return c.body(null, 204);
      })
  );
}
