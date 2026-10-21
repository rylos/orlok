import { createHash } from "node:crypto";
import { type ChatStreamEvent, type ConversationListItem, type Me, slugify } from "@orlok/shared";
import {
  conversationCreateSchema,
  conversationListQuerySchema,
  conversationUpdateSchema,
  messageCreateSchema,
  messageParamSchema,
  wikiCandidateParamSchema,
} from "@orlok/shared/schemas";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { currentUser, requireUser } from "../auth/middleware";
import { colleagues, conversations, messages, offices, opsJobs, wikiSources } from "../db/schema";
import { errorBody } from "../lib/errors";
import { idParamSchema, validate } from "../lib/validation";
import {
  bindAttachments,
  findUnsentAttachments,
  listAttachmentsByMessage,
} from "../services/chat-attachments";
import { runColleagueTurn } from "../services/colleague-turn";
import { findOwnColleague, isActive } from "../services/colleagues";
import { titleFromMessage, toConversationSummary, toMessage } from "../services/conversations";
import { conversationChanged } from "../services/live-events";
import { resolveColleagueModel } from "../services/models";
import { canAccessOffice } from "../services/offices";
import { runningTurns } from "../services/turn-registry";
import { listSources } from "../services/wiki-ingest";
import { transcriptOf } from "../services/wiki-reflect";
import { mirrorWebMessage } from "../telegram/publish";
import type { AppEnv, Deps } from "../types";

const conversationNotFound = errorBody("not_found", "Conversation not found");
const colleagueNotFound = errorBody("not_found", "Colleague not found");
const turnInProgress = errorBody("turn_in_progress", "The colleague is still answering");

// Watches a running turn for one page, from its beginning. Registered at once, before the
// response exists, so an answer that ends quickly is not missed; the events wait in order until
// the stream is there to take them. The page closing only stops the watching: the turn goes on
// without it (R-CHAT-13).
function watchTurn(conversationId: string) {
  const queued: ChatStreamEvent[] = [];
  let ended = false;
  let wake = () => {};
  const unfollow = runningTurns.follow(conversationId, {
    event: (event) => {
      queued.push(event);
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
  });
  if (!unfollow) {
    ended = true;
  }

  return async (stream: SSEStreamingApi) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      wake();
    });
    try {
      while (!closed) {
        for (let event = queued.shift(); event && !closed; event = queued.shift()) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        if (ended || closed) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } catch {
      // The page went away while an event was being written: nothing else to do.
    } finally {
      unfollow?.();
    }
  };
}

// Conversations of the signed-in person with their own AI colleagues (R-CHAT-2, R-ADM-3), only
// while they can still access the colleague's office.
export function conversationRoutes(deps: Deps) {
  const { db } = deps;
  async function findOwnConversation(user: Me, id: string) {
    const [row] = await db
      .select({ conversation: conversations, colleague: colleagues, office: offices })
      .from(conversations)
      .innerJoin(colleagues, eq(conversations.colleagueId, colleagues.id))
      .innerJoin(offices, eq(colleagues.officeId, offices.id))
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, user.id),
          eq(colleagues.userId, user.id),
        ),
      )
      .limit(1);
    if (!row || !(await canAccessOffice(db, user, row.office.id))) {
      return null;
    }
    return row;
  }

  type OwnConversation = NonNullable<Awaited<ReturnType<typeof findOwnConversation>>>;

  // Queues Markdown from a conversation as a wiki document for its colleague to file. Null when
  // the same text was already queued.
  async function queueWikiSource(
    row: OwnConversation,
    userId: string,
    title: string,
    date: string,
    markdown: string,
  ) {
    const data = Buffer.from(markdown, "utf8");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const [existing] = await db
      .select({ id: wikiSources.id })
      .from(wikiSources)
      .where(and(eq(wikiSources.officeId, row.office.id), eq(wikiSources.sha256, sha256)))
      .limit(1);
    if (existing) {
      return null;
    }
    const [source] = await db
      .insert(wikiSources)
      .values({
        officeId: row.office.id,
        fileName: `conversation-${slugify(title).slice(0, 60)}-${date}.md`,
        format: "markdown",
        mimeType: "text/markdown",
        sizeBytes: data.length,
        sha256,
        data,
        title,
        colleagueId: row.colleague.id,
        uploadedByUserId: userId,
      })
      .returning({ id: wikiSources.id });
    const [saved] = source ? await listSources(db, row.office.id, source.id) : [];
    return saved ?? null;
  }

  // Removes a proposal once saved or let go; updatedAt is kept, so the conversation does not
  // move in the list.
  async function dropCandidate(conversation: OwnConversation["conversation"], index: number) {
    await db
      .update(conversations)
      .set({
        wikiCandidates: conversation.wikiCandidates.filter((_, position) => position !== index),
        updatedAt: conversation.updatedAt,
      })
      .where(eq(conversations.id, conversation.id));
  }

  return (
    new Hono<AppEnv>()
      .use(requireUser)
      .get("/", validate("query", conversationListQuerySchema), async (c) => {
        const user = currentUser(c);
        const { colleagueId } = c.req.valid("query");
        // An archived colleague's conversations can still be read.
        if (!(await findOwnColleague(db, user, colleagueId))) {
          return c.json(colleagueNotFound, 404);
        }
        const rows = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.userId, user.id), eq(conversations.colleagueId, colleagueId)))
          .orderBy(desc(conversations.updatedAt))
          .limit(100);
        // The person's own requests still waiting for a decision; a plan's steps wait with it.
        const waiting = new Set(
          rows.length === 0
            ? []
            : (
                await db
                  .selectDistinct({ conversationId: opsJobs.conversationId })
                  .from(opsJobs)
                  .where(
                    and(
                      inArray(
                        opsJobs.conversationId,
                        rows.map((row) => row.id),
                      ),
                      eq(opsJobs.requestedForUserId, user.id),
                      eq(opsJobs.status, "pending_approval"),
                    ),
                  )
              ).map((row) => row.conversationId),
        );
        return c.json(
          rows.map(
            (row): ConversationListItem => ({
              ...toConversationSummary(row),
              waiting: waiting.has(row.id),
            }),
          ),
        );
      })
      .post("/", validate("json", conversationCreateSchema), async (c) => {
        const user = currentUser(c);
        const { colleagueId } = c.req.valid("json");
        const found = await findOwnColleague(db, user, colleagueId);
        if (!found || !isActive(found.colleague)) {
          return c.json(colleagueNotFound, 404);
        }
        const [row] = await db
          .insert(conversations)
          .values({ colleagueId, userId: user.id })
          .returning();
        if (!row) {
          throw new Error("Conversation insert returned no row");
        }
        conversationChanged(user.id, colleagueId, row.id);
        return c.json(toConversationSummary(row), 201);
      })
      .get("/:id", validate("param", idParamSchema), async (c) => {
        const row = await findOwnConversation(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(conversationNotFound, 404);
        }
        const messageRows = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, row.conversation.id))
          .orderBy(asc(messages.createdAt));
        const attachments = await listAttachmentsByMessage(
          db,
          messageRows.map((message) => message.id),
        );
        const profile = await resolveColleagueModel(db, row.colleague);
        return c.json({
          ...toConversationSummary(row.conversation),
          officeId: row.office.id,
          contextWindow: profile?.profile.contextWindow ?? null,
          compacted: row.conversation.summary !== null,
          running: runningTurns.isRunning(row.conversation.id),
          wikiCandidates: row.conversation.wikiCandidates,
          messages: messageRows.map((message) => toMessage(message, attachments.get(message.id))),
        });
      })
      .patch(
        "/:id",
        validate("param", idParamSchema),
        validate("json", conversationUpdateSchema),
        async (c) => {
          const row = await findOwnConversation(currentUser(c), c.req.valid("param").id);
          if (!row) {
            return c.json(conversationNotFound, 404);
          }
          const [updated] = await db
            .update(conversations)
            .set({ title: c.req.valid("json").title })
            .where(eq(conversations.id, row.conversation.id))
            .returning();
          conversationChanged(row.conversation.userId, row.colleague.id, row.conversation.id);
          return updated
            ? c.json(toConversationSummary(updated))
            : c.json(conversationNotFound, 404);
        },
      )
      .delete("/:id", validate("param", idParamSchema), async (c) => {
        const row = await findOwnConversation(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(conversationNotFound, 404);
        }
        await db.delete(conversations).where(eq(conversations.id, row.conversation.id));
        conversationChanged(row.conversation.userId, row.colleague.id, row.conversation.id, true);
        return c.body(null, 204);
      })
      // Saves the person's message and starts the colleague's answer, streamed to this page.
      .post(
        "/:id/messages",
        validate("param", idParamSchema),
        validate("json", messageCreateSchema),
        async (c) => {
          const user = currentUser(c);
          const { content, attachmentIds } = c.req.valid("json");
          const row = await findOwnConversation(user, c.req.valid("param").id);
          if (!row) {
            return c.json(conversationNotFound, 404);
          }
          if (!isActive(row.colleague)) {
            return c.json(errorBody("conflict", "The colleague is archived"), 409);
          }
          const target = await resolveColleagueModel(db, row.colleague);
          if (!target) {
            return c.json(
              errorBody("colleague_needs_profile", "The colleague needs another model profile"),
              409,
            );
          }
          if (!target.provider.enabled) {
            return c.json(
              errorBody("model_not_configured", "No enabled model profile is available"),
              409,
            );
          }

          const ids = [...new Set(attachmentIds)];
          const attached = await findUnsentAttachments(db, {
            ids,
            userId: user.id,
            colleagueId: row.colleague.id,
          });
          if (attached.length !== ids.length) {
            return c.json(errorBody("not_found", "Attachment not found"), 404);
          }
          const fileNames = attached.map((item) => item.fileName);

          const conversationId = row.conversation.id;
          // Claimed before the message is stored: a second message sent while the colleague is
          // still answering (another tab, another device) would start a second answer working
          // on the same things as the first.
          const claim = runningTurns.claim(conversationId);
          if (!claim) {
            return c.json(turnInProgress, 409);
          }
          try {
            const [stored] = await db
              .insert(messages)
              .values({ conversationId, role: "user", content })
              .returning({ id: messages.id });
            if (!stored) {
              throw new Error("Message insert returned no row");
            }
            await bindAttachments(db, ids, stored.id);
            await db
              .update(conversations)
              .set({
                updatedAt: new Date(),
                ...(row.conversation.title
                  ? {}
                  : { title: titleFromMessage(content || fileNames.join(", ")) }),
              })
              .where(eq(conversations.id, conversationId));
          } catch (error) {
            claim.release();
            throw error;
          }
          // Shown on the person's Telegram before the answer, which follows it there.
          await mirrorWebMessage(deps, {
            userId: user.id,
            conversationId,
            colleague: row.colleague,
            title: row.conversation.title || titleFromMessage(content || fileNames.join(", ")),
            content: [content, ...fileNames.map((name) => `📎 ${name}`)].filter(Boolean).join("\n"),
          }).catch((error: unknown) => {
            console.error("Telegram mirror failed", error);
          });

          const watch = watchTurn(conversationId);
          // Not awaited: the answer runs on its own, and this request is only its first watcher.
          void claim.run((signal, send) =>
            runColleagueTurn(deps, {
              conversation: row.conversation,
              colleague: row.colleague,
              office: row.office,
              user,
              retrievalText: [content, ...fileNames].filter(Boolean).join("\n"),
              signal,
              send,
            }),
          );
          return streamSSE(c, watch);
        },
      )
      // Follows the answer being written, from its beginning: a page opened while the colleague
      // is still working. Nothing running: an empty answer, and the page reads the stored one.
      .get("/:id/stream", validate("param", idParamSchema), async (c) => {
        const row = await findOwnConversation(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(conversationNotFound, 404);
        }
        const conversationId = row.conversation.id;
        if (!runningTurns.isRunning(conversationId)) {
          return c.body(null, 204);
        }
        return streamSSE(c, watchTurn(conversationId));
      })
      // Stop, the only thing that ends an answer early (R-CHAT-13).
      .post("/:id/stop", validate("param", idParamSchema), async (c) => {
        const row = await findOwnConversation(currentUser(c), c.req.valid("param").id);
        if (!row) {
          return c.json(conversationNotFound, 404);
        }
        runningTurns.stop(row.conversation.id);
        return c.body(null, 204);
      })
      // Asks the colleague to file an answer into the office wiki, like an uploaded document.
      .post("/:id/messages/:messageId/wiki", validate("param", messageParamSchema), async (c) => {
        const user = currentUser(c);
        const { id, messageId } = c.req.valid("param");
        const row = await findOwnConversation(user, id);
        if (!row) {
          return c.json(conversationNotFound, 404);
        }
        const thread = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, row.conversation.id))
          .orderBy(asc(messages.createdAt));
        const index = thread.findIndex((message) => message.id === messageId);
        const answer = thread[index];
        if (answer?.role !== "assistant" || !answer.content.trim()) {
          return c.json(errorBody("not_found", "Answer not found"), 404);
        }
        const question = thread
          .slice(0, index)
          .reverse()
          .find((message) => message.role === "user");
        const date = answer.createdAt.toISOString().slice(0, 10);
        const title =
          row.conversation.title ?? titleFromMessage(question?.content ?? answer.content);
        const markdown = [
          `# ${title}`,
          "",
          `Answer saved from a conversation between ${user.displayName} and ${row.colleague.name} on ${date}.`,
          "",
          "## Question",
          "",
          question?.content ?? "",
          "",
          "## Answer",
          "",
          answer.content,
          "",
        ].join("\n");
        const saved = await queueWikiSource(row, user.id, title, date, markdown);
        return saved
          ? c.json(saved, 201)
          : c.json(errorBody("conflict", "This answer was already saved to the wiki"), 409);
      })
      // Saves what the colleague proposed to keep (R-MEM-16): filed like a saved answer, from the
      // proposal and the conversation it came from.
      .post(
        "/:id/wiki-candidates/:index",
        validate("param", wikiCandidateParamSchema),
        async (c) => {
          const user = currentUser(c);
          const { id, index } = c.req.valid("param");
          const row = await findOwnConversation(user, id);
          const candidate = row?.conversation.wikiCandidates[index];
          if (!row || !candidate) {
            return c.json(errorBody("not_found", "Proposal not found"), 404);
          }
          const thread = await db
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.conversationId, row.conversation.id))
            .orderBy(asc(messages.createdAt));
          const date = new Date().toISOString().slice(0, 10);
          const markdown = [
            `# ${candidate.title}`,
            "",
            `Knowledge proposed for the wiki from a conversation between ${user.displayName} and ${row.colleague.name}, saved on ${date}.`,
            "",
            candidate.summary,
            ...(candidate.slug ? ["", `Probably concerns [[${candidate.slug}]].`] : []),
            "",
            "## Conversation",
            "",
            transcriptOf(thread),
            "",
          ].join("\n");
          const saved = await queueWikiSource(row, user.id, candidate.title, date, markdown);
          await dropCandidate(row.conversation, index);
          return saved
            ? c.json(saved, 201)
            : c.json(errorBody("conflict", "Already saved to the wiki"), 409);
        },
      )
      .delete(
        "/:id/wiki-candidates/:index",
        validate("param", wikiCandidateParamSchema),
        async (c) => {
          const { id, index } = c.req.valid("param");
          const row = await findOwnConversation(currentUser(c), id);
          if (!row?.conversation.wikiCandidates[index]) {
            return c.json(errorBody("not_found", "Proposal not found"), 404);
          }
          await dropCandidate(row.conversation, index);
          return c.body(null, 204);
        },
      )
  );
}
