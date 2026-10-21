import {
  type ChatStreamEvent,
  type ErrorCode,
  type Me,
  type MessagePart,
  type MessageStatus,
  slugify,
  type TokenUsage,
  type WikiEdit,
} from "@orlok/shared";
import { and, asc, eq, or } from "drizzle-orm";
import { toMe } from "../auth/sessions";
import {
  type ColleagueRow,
  type ConversationRow,
  colleagues,
  conversations,
  messages,
  type OfficeRow,
  offices,
  users,
} from "../db/schema";
import { describeProviderError, type LlmMessage, ModelRefusalError } from "../llm";
import { findJobRow, formatJobResult, markReported, PLAN_FINISHED_STATUSES } from "../ops/jobs";
import { formatPlanResult, getPlanRow, markPlanReported, planSteps } from "../ops/plans";
import { createOpsTools, opsInstructions } from "../ops/tools";
import { publishAnswer } from "../telegram/publish";
import type { Deps } from "../types";
import { runAgent } from "./agent";
import { toModelHistory } from "./chat-attachments";
import { createNotesTool } from "./colleague-notes";
import { isActive } from "./colleagues";
import { compactHistory, historyAfterSummary, saveSummary, summaryMessage } from "./compaction";
import {
  CHARS_PER_TOKEN,
  contextWindowFromError,
  estimatePromptTokens,
  estimateTextTokens,
  isContextOverflowError,
  overflowedSilently,
  planTurn,
  promptBudget,
  toolResultMaxChars,
  trimHistory,
} from "./context";
import { buildColleagueSystemPrompt } from "./conversations";
import { BudgetExceededError, metered } from "./costs";
import { resolveEmbedder } from "./embeddings";
import { getSetupStatus } from "./installation";
import { conversationChanged } from "./live-events";
import { connectionFor, resolveColleagueModel } from "./models";
import { notifyApprovalNeeded } from "./notifications";
import { runningTurns } from "./turn-registry";
import { getWikiAccess, listPages } from "./wiki";
import { searchQueryForTurn } from "./wiki-query";
import { conversationQuery, retrieveContextPages } from "./wiki-retrieval";
import { createWikiTools, mergeEdits } from "./wiki-tools";

// Summarizing needs a request size even when the model's window is unknown. This is not a guess
// about the model: it is a small request that any model we can talk to accepts.
const SUMMARY_FALLBACK_WINDOW = 32_000;

// The pages an answer links with [[slug]] or [[slug|label]].
export function citedSlugs(text: string) {
  return [
    ...new Set(
      [...text.matchAll(/\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)].map((match) => slugify(match[1] ?? "")),
    ),
  ].filter(Boolean);
}

export type TurnInput = {
  conversation: ConversationRow;
  colleague: ColleagueRow;
  office: OfficeRow;
  user: Me;
  // Text used to retrieve wiki context: the latest message, or the command of a finished job.
  retrievalText: string;
  // Searched as it is, without a model writing the search: a command, a plan title.
  searchAsWritten?: boolean;
  // Not stored: given to the model after the stored history (e.g. a job result).
  extraMessage?: string;
  signal: AbortSignal;
  send: (event: ChatStreamEvent) => Promise<void>;
};

// One answer of a colleague in a conversation: wiki context, tools (wiki and commands), the
// model's tool loop and the stored assistant message. Returns false when no model is available.
// The person's open pages hear when it starts and ends, wherever it was asked from.
export async function runColleagueTurn(deps: Deps, input: TurnInput) {
  const changed = () =>
    conversationChanged(input.user.id, input.colleague.id, input.conversation.id);
  changed();
  let answered: Awaited<ReturnType<typeof answer>>;
  try {
    answered = await answer(deps, input);
  } finally {
    changed();
  }
  // Telegram shows the conversation it follows the way the web does (R-CHAT-12). No model, no
  // answer stored: nothing new to show.
  if (answered !== false) {
    await publishAnswer(deps, input.user.id, input.conversation.id).catch((error: unknown) => {
      console.error("Telegram answer failed", error);
    });
  }
  return answered;
}

async function answer(deps: Deps, input: TurnInput) {
  const { db, config, llm, localEmbedder } = deps;
  const { conversation, colleague, office, user, signal, send } = input;
  const target = await resolveColleagueModel(db, colleague);
  if (!target?.provider.enabled) {
    return false;
  }

  // Failed or stopped answers are shown to the person but not sent back to the model.
  const storedHistory = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      opsJobIds: messages.opsJobIds,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        or(eq(messages.role, "user"), eq(messages.status, "complete")),
      ),
    )
    .orderBy(asc(messages.createdAt));
  // The model is given the summary of what was compacted, then everything said after it.
  let { rows, summary } = historyAfterSummary(storedHistory, conversation);
  async function buildHistory(): Promise<LlmMessage[]> {
    return [
      ...(summary ? [summaryMessage(summary)] : []),
      ...(await toModelHistory(db, rows)),
      ...(input.extraMessage ? [{ role: "user" as const, content: input.extraMessage }] : []),
    ];
  }
  let history = await buildHistory();

  // The colleague consults the office wiki before answering (R-MEM-4).
  const wikiIndex = await listPages(db, office.id);
  const embedder =
    wikiIndex.length > 0
      ? await resolveEmbedder({ db, llm, localEmbedder, secretKey: config.secretKey })
      : null;
  // A quarter of what the prompt may hold, in characters: enough on a large model, and not the
  // whole budget on a small one.
  const wikiCharacters = target.profile.contextWindow
    ? Math.floor(promptBudget(target.profile.contextWindow, target.profile.maxOutputTokens))
    : null;
  const earlier = storedHistory
    .filter((row) => row.role === "user")
    .slice(0, -1)
    .map((row) => row.content);
  const fallback = conversationQuery(input.retrievalText, earlier);
  const query =
    wikiIndex.length === 0
      ? ""
      : input.searchAsWritten
        ? fallback
        : await searchQueryForTurn(deps, {
            officeId: office.id,
            userId: user.id,
            colleagueId: colleague.id,
            conversationId: conversation.id,
            colleagueModel: { provider: target.provider, model: target.profile.model },
            context: {
              sections: [
                ...new Set(wikiIndex.flatMap((page) => (page.section ? [page.section] : []))),
              ],
              title: conversation.title,
              earlier,
              previousAnswer:
                storedHistory.findLast((row) => row.role === "assistant")?.content ?? null,
              message: input.retrievalText,
            },
            fallback,
            signal,
          });
  const wikiContext = query
    ? await retrieveContextPages(
        db,
        office.id,
        query,
        embedder,
        ...(wikiCharacters ? [Math.floor(wikiCharacters * CHARS_PER_TOKEN * 0.25)] : []),
      )
    : [];
  const wikiPages = wikiContext.map(({ slug, title }) => ({ slug, title }));

  const wikiEdits: WikiEdit[] = [];
  // The pages shown under the answer: those the colleague read or cited. The pages it was given
  // are not all of them: the search can bring a page the answer never needed.
  const wikiUsed = new Map<string, string>();
  const usedPages = () => [...wikiUsed].map(([slug, title]) => ({ slug, title }));
  let announcedUsed = "[]";
  const opsJobIds = new Set<string>();
  const pendingEvents: ChatStreamEvent[] = [];
  // The answer as it happens (R-CHAT-4): the model writes, stops to run a command, writes again.
  // The events already arrive in that order, so closing the open text part when a command is
  // born is all it takes to keep each command card where the answer paused for it.
  const parts: MessagePart[] = [];
  let paragraph = "";
  function closeText() {
    // The blank line that separates what was said before a command from what is said after it
    // belongs to the whole answer, not to either side of the card.
    const text = paragraph.trim();
    paragraph = "";
    if (text !== "") {
      parts.push({ type: "text", text });
    }
  }
  // A person who may not edit the wiki gets proposals from their colleague, not edits (R-MEM-3).
  const canEditWiki = (await getWikiAccess(db, user, office.id))?.canEdit ?? false;
  const wikiTools = createWikiTools({
    db,
    officeId: office.id,
    colleagueId: colleague.id,
    source: `Conversation with ${user.displayName}, ${new Date().toISOString().slice(0, 10)}`,
    logDetail: `conversation with ${user.displayName}`,
    embedder,
    reviewer: { userId: user.id, canResolve: canEditWiki },
    ...(canEditWiki ? {} : { proposeFor: user.displayName }),
    onEdit: (edit) => {
      wikiEdits.push(edit);
      pendingEvents.push({ type: "wiki_edit", edit });
    },
    onRead: (page) => {
      if (!wikiUsed.has(page.slug)) {
        wikiUsed.set(page.slug, page.title);
        const pages = usedPages();
        announcedUsed = JSON.stringify(pages);
        pendingEvents.push({ type: "wiki_used", pages });
      }
    },
    // The commands run so far in this answer are what the colleague may have learnt it from.
    origin: () => ({
      conversationId: conversation.id,
      ...(opsJobIds.size > 0 ? { opsJobIds: [...opsJobIds] } : {}),
    }),
  });
  const opsTools = await createOpsTools({
    deps,
    officeId: office.id,
    colleagueId: colleague.id,
    conversationId: conversation.id,
    userId: user.id,
    locale: user.locale,
    // Hosts come from the person's credentials, how commands run from the colleague's profile
    // (R-MOD-2, R-OPS-3).
    policy: { mode: target.profile.mode },
    signal,
    onApprovalNeeded: (request) => {
      // The person's open pages mark the conversation as waiting now, not when the answer ends:
      // the colleague may wait minutes for the decision, and the tab may have been left.
      conversationChanged(user.id, colleague.id, conversation.id);
      notifyApprovalNeeded(deps, {
        conversationId: conversation.id,
        colleagueId: colleague.id,
        requestedForUserId: user.id,
        ...request,
      }).catch((error: unknown) => console.error("Approval notification failed", error));
    },
    // Job updates arrive while a tool waits: send them right away, the stream is open.
    onJob: (job) => {
      if (!opsJobIds.has(job.id)) {
        opsJobIds.add(job.id);
        closeText();
        parts.push({ type: "job", jobId: job.id });
      }
      void send({ type: "ops_job", job });
    },
  });

  const operations = await opsInstructions(
    deps,
    user.id,
    user.locale,
    target.profile.mode,
    opsTools.length > 0,
  );
  const system = [
    buildColleagueSystemPrompt({
      companyName: (await getSetupStatus(db)).companyName,
      office,
      colleague,
      user,
      wiki: {
        index: wikiIndex,
        pages: wikiContext,
        purpose: office.wikiPurpose,
        today: new Date().toISOString().slice(0, 10),
      },
    }),
    ...(operations ? [operations] : []),
  ].join("\n\n");
  // Every call is on the ledger and under the spending limits of the person and office (R-MOD-4).
  const connection = llm(connectionFor(target.provider, config.secretKey));
  const meter = {
    provider: target.provider,
    officeId: office.id,
    userId: user.id,
    colleagueId: colleague.id,
    conversationId: conversation.id,
  };
  const client = metered(deps, connection, { ...meter, purpose: "chat" });
  const compactionClient = metered(deps, connection, { ...meter, purpose: "compaction" });

  if (wikiPages.length > 0) {
    await send({ type: "context", pages: wikiPages });
  }

  let answer = "";
  // Held in an object: the tool loop writes it from inside a closure.
  const reported: { usage: TokenUsage | null } = { usage: null };
  let status: MessageStatus = "complete";
  let errorCode: ErrorCode | null = null;

  const tools = [...wikiTools, createNotesTool(db, colleague.id), ...opsTools];
  const { model, maxOutputTokens, contextWindow } = target.profile;
  let compacted = false;

  // Replaces the oldest messages with a summary of them. False when there was nothing worth
  // summarizing, so the caller does not report a recovery that did not happen.
  async function compact(options: { window?: number | null; keepRecentTokens?: number } = {}) {
    if (compacted) {
      return false;
    }
    compacted = true;
    const result = await compactHistory({
      client: compactionClient,
      model,
      maxOutputTokens,
      contextWindow: contextWindow ?? options.window ?? SUMMARY_FALLBACK_WINDOW,
      rows,
      previousSummary: summary,
      signal,
      ...(options.keepRecentTokens ? { keepRecentTokens: options.keepRecentTokens } : {}),
    });
    if (!result) {
      return false;
    }
    await saveSummary(db, conversation.id, result);
    summary = result.summary;
    rows = result.keptRows;
    history = await buildHistory();
    return true;
  }

  // Measures the turn against the window and makes it fit: shortening command output and
  // attachments when that is enough, summarizing the conversation when it is not (R-MOD-6).
  // Without a window the turn goes out as it is and only the provider's refusal can save it.
  async function fitTurn() {
    if (!contextWindow) {
      return;
    }
    for (let round = 0; round < 3; round++) {
      const plan = planTurn({ system, messages: history, tools, contextWindow, maxOutputTokens });
      if (plan.route === "fits") {
        return;
      }
      if (plan.route !== "trim" && (await compact())) {
        continue;
      }
      const trimmed = trimHistory(history, plan.toolResultMaxChars);
      if (trimmed.freedChars > 0) {
        history = trimmed.messages;
        continue;
      }
      // Nothing older left to shorten: the attachment of the message just sent is cut too. A
      // document arriving whole and refused whole helps nobody; its beginning and its end do.
      history = trimHistory(history, plan.toolResultMaxChars, 0).messages;
      return;
    }
  }

  async function run() {
    for await (const event of runAgent({
      client,
      model,
      maxOutputTokens,
      system,
      messages: history,
      tools,
      signal,
      ...(contextWindow ? { toolResultMaxChars: toolResultMaxChars(contextWindow) } : {}),
    })) {
      if (event.type === "text") {
        answer += event.text;
        paragraph += event.text;
        await send(event);
      } else if (event.type === "tool_start" || event.type === "tool_call") {
        // Announced as soon as the model starts writing the call: a long wiki page can take
        // minutes to write, and the page must not look stuck meanwhile.
        await send({
          type: "tool",
          name: event.type === "tool_start" ? event.name : event.call.name,
        });
      } else if (event.type === "tool_result") {
        for (const pending of pendingEvents.splice(0)) {
          await send(pending);
        }
      } else {
        reported.usage = event.usage;
        await send({ type: "done", stopReason: event.stopReason, usage: event.usage });
      }
    }
  }

  async function failed(error: unknown) {
    if (signal.aborted) {
      status = "stopped";
      return;
    }
    status = "error";
    errorCode =
      error instanceof BudgetExceededError
        ? "budget_exceeded"
        : error instanceof ModelRefusalError
          ? "model_refused"
          : isContextOverflowError(error)
            ? "context_overflow"
            : "provider_error";
    await send({ type: "error", code: errorCode, message: describeProviderError(error) });
  }

  try {
    await fitTurn();
    await run();
  } catch (error) {
    // A prompt refused for its size can be retried once, but only while the answer has not
    // started and no tool has run: a command is not replayed to make a request smaller.
    const untouched =
      answer === "" && parts.length === 0 && opsJobIds.size === 0 && wikiEdits.length === 0;
    // Whatever the window turns out to be, a refused prompt has to lose about half of what it
    // carried: the provider just proved that the rest does not fit.
    const half = Math.floor(
      rows.reduce((total, row) => total + estimateTextTokens(row.content), 0) / 2,
    );
    const recovery = { window: contextWindowFromError(error), keepRecentTokens: half };
    if (
      !signal.aborted &&
      isContextOverflowError(error) &&
      untouched &&
      (await compact(recovery))
    ) {
      try {
        await fitTurn();
        await run();
      } catch (retried) {
        await failed(retried);
      }
    } else {
      await failed(error);
    }
  }

  // Stopped is stopped however the provider ended: the OpenAI SDK closes an aborted stream as if
  // the answer were over, with no error to catch, and the half answer would pass for complete.
  if (signal.aborted && status === "complete") {
    status = "stopped";
  }
  closeText();
  const titles = new Map(wikiIndex.map((page) => [page.slug, page.title]));
  for (const slug of citedSlugs(answer)) {
    const title = titles.get(slug);
    if (title && !wikiUsed.has(slug)) {
      wikiUsed.set(slug, title);
    }
  }
  // A page updated by the answer is shown as updated, not again as used.
  for (const edit of wikiEdits) {
    wikiUsed.delete(edit.slug);
  }
  const used = usedPages();
  // Open pages heard the pages read as they were read; the cited ones come with the end.
  if (used.length > 0 && JSON.stringify(used) !== announcedUsed) {
    await send({ type: "wiki_used", pages: used }).catch(() => undefined);
  }
  await db.insert(messages).values({
    conversationId: conversation.id,
    role: "assistant",
    content: answer,
    status,
    errorCode,
    model: target.profile.model,
    inputTokens: reported.usage?.inputTokens ?? null,
    outputTokens: reported.usage?.outputTokens ?? null,
    wikiPages: used.length > 0 ? used : null,
    wikiGiven: wikiPages.length > 0 ? wikiPages : null,
    wikiEdits: wikiEdits.length > 0 ? mergeEdits(wikiEdits) : null,
    opsJobIds: opsJobIds.size > 0 ? [...opsJobIds] : null,
    parts: parts.length > 0 ? parts : null,
  });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  // Some providers do not refuse an oversized prompt: they drop its beginning and answer anyway,
  // and the only trace is a token count sitting at the window. Summarize now so the next turn
  // starts smaller, rather than losing the beginning again in silence.
  if (
    status === "complete" &&
    overflowedSilently({
      usage: reported.usage,
      contextWindow,
      estimatedTokens: estimatePromptTokens({ system, messages: history, tools }),
      truncatesSilently: target.provider.kind === "ollama",
    })
  ) {
    await compact().catch((error: unknown) => {
      console.warn("Compaction after a full context window failed", error);
    });
  }
  return true;
}

// When a command approved after the answer ended finishes, the colleague continues the
// conversation with its result (R-OPS-5).
export async function continueAfterJob(deps: Deps, jobId: string) {
  const job = await findJobRow(deps.db, jobId);
  if (!job?.conversationId) {
    return;
  }
  let extraMessage: string;
  let retrievalText = job.command;
  if (job.planId) {
    // Steps of a plan are reported together, once the whole plan has ended (R-OPS-6).
    const plan = await getPlanRow(deps.db, job.planId);
    if (
      !plan ||
      plan.reported ||
      !PLAN_FINISHED_STATUSES.includes(plan.status) ||
      !(await markPlanReported(deps.db, plan.id))
    ) {
      return;
    }
    retrievalText = plan.title;
    extraMessage = `<ops_plan_result>\n${formatPlanResult(plan, await planSteps(deps.db, plan.id))}\n</ops_plan_result>\nThis is the result of a plan you proposed earlier; it was approved and ran after your previous answer. Tell the person what happened and continue helping.`;
  } else {
    if (job.reported || !(await markReported(deps.db, job.id))) {
      return;
    }
    extraMessage =
      job.error === "interrupted"
        ? `<ops_job_result>\n${formatJobResult(job)}\n</ops_job_result>\nThis is a command you asked to run earlier. Tell the person it was interrupted and that its outcome is unknown, check the state before anything else, and continue helping.`
        : `<ops_job_result>\n${formatJobResult(job)}\n</ops_job_result>\nThis is the result of a command you asked to run earlier; it was approved and ran after your previous answer. Tell the person what it shows and continue helping.`;
  }
  // One answer at a time in a conversation: this one waits for the answer being written, and
  // like any other it can be followed from a page and stopped (R-CHAT-13).
  const conversationId = job.conversationId;
  let claim = runningTurns.claim(conversationId);
  while (!claim) {
    await runningTurns.idle(conversationId);
    claim = runningTurns.claim(conversationId);
  }
  // Read once the conversation is ours: the answer before may have just summarized it.
  const [row] = await deps.db
    .select({ conversation: conversations, colleague: colleagues, office: offices, user: users })
    .from(conversations)
    .innerJoin(colleagues, eq(conversations.colleagueId, colleagues.id))
    .innerJoin(offices, eq(colleagues.officeId, offices.id))
    .innerJoin(users, eq(conversations.userId, users.id))
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .catch((error: unknown) => {
      claim.release();
      throw error;
    });
  if (!row || !isActive(row.colleague) || row.user.disabledAt) {
    claim.release();
    return;
  }
  await claim.run((signal, send) =>
    runColleagueTurn(deps, {
      conversation: row.conversation,
      colleague: row.colleague,
      office: row.office,
      user: toMe(row.user),
      retrievalText,
      searchAsWritten: true,
      extraMessage,
      signal,
      send,
    }),
  );
}
