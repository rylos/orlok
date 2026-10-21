import type { Locale, OpsJob, OpsJobStatus } from "@orlok/shared";
import { and, desc, eq } from "drizzle-orm";
import { colleagues, conversations, messages, telegramAccounts, users } from "../db/schema";
import { listJobs } from "../ops/jobs";
import { partsOf } from "../services/conversations";
import type { Deps } from "../types";
import { splitMessage, TELEGRAM_MESSAGE_MAX, type TelegramApi, TelegramError } from "./api";
import { escapeHtml, htmlToText, markdownToTelegram } from "./format";
import { getTelegramBot } from "./settings";

// Telegram and the web app show one conversation, the same way (R-CHAT-12). Telegram follows the
// conversation the person last wrote in, from either side: what is written on the web shows up
// on Telegram, and every answer — asked from the web, from Telegram, or the follow-up after a
// late approval — reaches Telegram as the web shows it: its text formatted, the command cards
// where the answer paused for them, the wiki pages updated and consulted, a stop or a failure.

type PublishDeps = Pick<Deps, "db" | "config" | "telegram">;

const TEXT = {
  en: {
    failed: "The colleague could not answer. Open Orlok for details.",
    stopped: "Answer stopped",
    fromWeb: "From the web",
    following: (title: string, name: string) => `Now in “${title}” with ${name}, from the web.`,
    untitled: "Untitled",
    runner: "Orlok runner",
    exitCode: (code: number) => `exit code ${code}`,
    wikiUpdated: "Wiki updated",
    wikiNew: "new",
    wikiUsed: "Wiki pages consulted",
    output: "Output",
    statuses: {
      pending_approval: "Waiting for approval",
      queued: "Queued",
      running: "Running",
      done: "Done",
      failed: "Failed",
      timeout: "Timed out",
      stopped: "Stopped",
      denied: "Denied",
      expired: "Expired",
    } satisfies Record<OpsJobStatus, string>,
  },
  it: {
    failed: "Il collega non è riuscito a rispondere. Apri Orlok per i dettagli.",
    stopped: "Risposta interrotta",
    fromWeb: "Dal web",
    following: (title: string, name: string) => `Ora in «${title}» con ${name}, dal web.`,
    untitled: "Senza titolo",
    runner: "Orlok runner",
    exitCode: (code: number) => `codice di uscita ${code}`,
    wikiUpdated: "Wiki aggiornata",
    wikiNew: "nuova",
    wikiUsed: "Pagine wiki consultate",
    output: "Output",
    statuses: {
      pending_approval: "In attesa di approvazione",
      queued: "In coda",
      running: "In esecuzione",
      done: "Completato",
      failed: "Non riuscito",
      timeout: "Tempo scaduto",
      stopped: "Fermato",
      denied: "Negato",
      expired: "Scaduto",
    } satisfies Record<OpsJobStatus, string>,
  },
} as const;

function text(locale: Locale | null | undefined) {
  return locale === "it" ? TEXT.it : TEXT.en;
}

// The end of a command's output: Telegram has room for a message, not for a log.
const OUTPUT_TAIL = 1_500;

function jobCard(job: OpsJob, locale: Locale) {
  const t = text(locale);
  const where =
    job.target.kind === "runner"
      ? t.runner
      : job.target.kind === "host"
        ? job.target.name
        : `${job.target.name} · ${job.target.tool}`;
  const status = `${t.statuses[job.status]}${job.exitCode !== null ? ` · ${t.exitCode(job.exitCode)}` : ""}`;
  const language =
    job.target.kind === "mcp" ? "json" : job.shell === "powershell" ? "powershell" : "bash";
  const command = job.target.kind === "mcp" ? (job.toolInput ?? job.command) : job.command;
  const lines = [
    `⚙️ <b>${escapeHtml(where)}</b> · ${escapeHtml(status)}`,
    `<pre><code class="language-${language}">${escapeHtml(command.slice(0, 1_500))}</code></pre>`,
  ];
  if (job.reason) {
    lines.push(`<i>${escapeHtml(job.reason.slice(0, 300))}</i>`);
  }
  const output = job.output.trim();
  if (output) {
    const tail = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
    lines.push(`<blockquote expandable>${escapeHtml(tail)}</blockquote>`);
  } else if (job.error && job.status !== "done") {
    lines.push(`<i>${escapeHtml(job.error.slice(0, 300))}</i>`);
  }
  return lines.join("\n");
}

// Pieces of HTML in order, packed into as few messages as fit.
function pack(pieces: string[], max = TELEGRAM_MESSAGE_MAX) {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length > max && current) {
      out.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

type AnswerRow = typeof messages.$inferSelect;

export async function renderAnswer(
  deps: Pick<Deps, "db" | "config">,
  answer: AnswerRow,
  officeId: string,
  locale: Locale,
) {
  const t = text(locale);
  const parts = partsOf(answer);
  const jobIds = parts.flatMap((part) => (part.type === "job" ? [part.jobId] : []));
  const jobs = new Map(
    (jobIds.length > 0 ? await listJobs(deps.db, officeId, { ids: jobIds }) : []).map((job) => [
      job.id,
      job,
    ]),
  );
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      pieces.push(...markdownToTelegram(part.text));
    } else {
      const job = jobs.get(part.jobId);
      if (job) pieces.push(jobCard(job, locale));
    }
  }
  const wikiLink = (page: { slug: string; title: string }, suffix = "") =>
    `<a href="${escapeHtml(`${deps.config.publicUrl}/offices/${officeId}/wiki/${page.slug}`)}">${escapeHtml(page.title)}</a>${suffix}`;
  const footer: string[] = [];
  if (answer.wikiEdits?.length) {
    footer.push(
      `📝 ${t.wikiUpdated}: ${answer.wikiEdits
        .map((edit) => wikiLink(edit, edit.action === "create" ? ` · ${t.wikiNew}` : ""))
        .join(", ")}`,
    );
  }
  if (answer.wikiPages?.length) {
    footer.push(`📚 ${t.wikiUsed}: ${answer.wikiPages.map((page) => wikiLink(page)).join(", ")}`);
  }
  if (answer.status === "stopped") {
    footer.push(`<i>${t.stopped}</i>`);
  } else if (answer.status === "error") {
    footer.push(`⚠️ ${t.failed}`);
  }
  if (footer.length > 0) {
    pieces.push(footer.join("\n"));
  }
  return pack(pieces);
}

// HTML first; a piece Telegram refuses to parse goes as plain text.
async function sendHtml(api: TelegramApi, chatId: number, pieces: string[]) {
  for (const piece of pieces) {
    try {
      await api.sendMessage(chatId, piece, undefined, { html: true });
    } catch (error) {
      if (!(error instanceof TelegramError) || error.status !== 400) {
        throw error;
      }
      for (const plain of splitMessage(htmlToText(piece))) {
        await api.sendMessage(chatId, plain);
      }
    }
  }
}

// The person's Telegram, when a bot is configured and they linked it.
async function linkedChat(deps: PublishDeps, userId: string) {
  const bot = await getTelegramBot(deps.db, deps.config.secretKey);
  if (!bot) {
    return null;
  }
  const [row] = await deps.db
    .select({ account: telegramAccounts, locale: users.locale })
    .from(telegramAccounts)
    .innerJoin(users, eq(telegramAccounts.userId, users.id))
    .where(eq(telegramAccounts.userId, userId))
    .limit(1);
  return row ? { ...row, api: deps.telegram(bot.token) } : null;
}

// The last answer of a conversation, sent to the person's Telegram if it follows that
// conversation. Called when any answer ends, wherever it was asked from.
export async function publishAnswer(deps: PublishDeps, userId: string, conversationId: string) {
  const chat = await linkedChat(deps, userId);
  if (!chat || chat.account.conversationId !== conversationId) {
    return;
  }
  const [row] = await deps.db
    .select({ answer: messages, officeId: colleagues.officeId })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(colleagues, eq(conversations.colleagueId, colleagues.id))
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!row) {
    return;
  }
  const pieces = await renderAnswer(deps, row.answer, row.officeId, chat.locale);
  await sendHtml(chat.api, chat.account.chatId, pieces);
}

// A message written on the web: Telegram moves to that conversation (saying so when it changes)
// and shows the message, so the chat there reads like the one on the web.
export async function mirrorWebMessage(
  deps: PublishDeps,
  input: {
    userId: string;
    conversationId: string;
    colleague: { id: string; name: string };
    title: string;
    content: string;
  },
) {
  const chat = await linkedChat(deps, input.userId);
  if (!chat) {
    return;
  }
  const t = text(chat.locale);
  const { chatId } = chat.account;
  if (chat.account.conversationId !== input.conversationId) {
    await deps.db
      .update(telegramAccounts)
      .set({ colleagueId: input.colleague.id, conversationId: input.conversationId })
      .where(eq(telegramAccounts.userId, input.userId));
    await chat.api.sendMessage(
      chatId,
      t.following(input.title || t.untitled, input.colleague.name),
    );
  }
  const body = input.content.slice(0, TELEGRAM_MESSAGE_MAX - 200);
  await sendHtml(chat.api, chatId, [`🖥 <i>${t.fromWeb}</i>\n${escapeHtml(body)}`]);
}
