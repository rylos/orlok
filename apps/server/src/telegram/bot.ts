import type { Locale } from "@orlok/shared";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { toMe } from "../auth/sessions";
import type { Db } from "../db/client";
import {
  colleagues,
  conversations,
  messages,
  offices,
  opsJobs,
  opsPlans,
  telegramAccounts,
  type UserRow,
  users,
} from "../db/schema";
import { decideJob } from "../ops/jobs";
import { decidePlan } from "../ops/plans";
import { runColleagueTurn } from "../services/colleague-turn";
import { isActive } from "../services/colleagues";
import { titleFromMessage } from "../services/conversations";
import { conversationChanged } from "../services/live-events";
import { resolveColleagueModel } from "../services/models";
import { canAccessOffice } from "../services/offices";
import { runningTurns } from "../services/turn-registry";
import type { Deps } from "../types";
import {
  type TelegramApi,
  type TelegramCallbackQuery,
  TelegramError,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api";
import { settlePrompts } from "./prompts";
import { publishAnswer } from "./publish";
import { consumeLinkToken, getOffset, getTelegramBot, setOffset } from "./settings";

// The Telegram channel (R-CHAT-10, R-CHAT-12): one bot for the installation, which dispatches to
// the person's own colleagues, in the same conversations as the web app. Private chats only, and
// only from accounts linked to a person with a one-time link from their account page.

export type TelegramDeps = Deps & { telegram: (token: string) => TelegramApi };

const TEXT = {
  en: {
    unlinked:
      "This Telegram account is not linked to Orlok. Open Orlok → Account → Telegram and use the link shown there.",
    linked: (name: string) =>
      `Linked to Orlok as ${name}. Write to talk with your colleagues; /colleague to choose one, /new to start a new conversation.`,
    linkInvalid: "This link is not valid any more: create a new one in Orlok → Account → Telegram.",
    otherAccount: "This Telegram account is already linked to another person in Orlok.",
    noColleagues: "You have no colleagues yet: create one in Orlok first.",
    choose: "Which colleague do you want to talk with?",
    chosen: (name: string) => `Now talking with ${name}. /new starts a new conversation.`,
    newConversation: (name: string) => `New conversation with ${name}.`,
    help: "Write to talk with your colleague. /colleague chooses one, /new starts a new conversation, /conversations resumes or deletes one. Approvals arrive here with their buttons.",
    noConversations: "No conversations yet: just write to start one.",
    conversations: "Your latest conversations. Choose one to continue it, or 🗑 to delete it.",
    resumed: (title: string, name: string) => `Continuing “${title}” with ${name}.`,
    confirmDelete: (title: string) =>
      `Delete “${title}” and all its messages? It cannot be undone.`,
    deleteYes: "Delete",
    deleteNo: "Cancel",
    deleted: "Conversation deleted.",
    kept: "Nothing deleted.",
    busy: "The colleague is still answering in that conversation: try again when it has finished.",
    gone: "That conversation no longer exists.",
    untitled: "Untitled",
    needsProfile: "This colleague has no model profile it may use: choose one in Orlok.",
    unavailable: "This colleague is not available at the moment.",
    failed: "The colleague could not answer. Open Orlok for details.",
    approved: "Approved.",
    approvedAlways: (types: string[]) =>
      `Always allowed for you, with all your colleagues, on every host: ${types.join(", ")}. You can take it back in Orlok → Account.`,
    denied: "Denied.",
    alreadyDecided: "Already decided.",
    decideInApp: "This one is decided in Orlok, not from Telegram.",
    notYours: "Only the person it was asked for can decide it.",
  },
  it: {
    unlinked:
      "Questo account Telegram non è collegato a Orlok. Apri Orlok → Account → Telegram e usa il link che trovi lì.",
    linked: (name: string) =>
      `Collegato a Orlok come ${name}. Scrivi per parlare con i tuoi colleghi; /colleague per sceglierne uno, /new per una nuova conversazione.`,
    linkInvalid: "Questo link non è più valido: creane uno nuovo in Orlok → Account → Telegram.",
    otherAccount: "Questo account Telegram è già collegato a un'altra persona in Orlok.",
    noColleagues: "Non hai ancora colleghi: creane uno in Orlok.",
    choose: "Con quale collega vuoi parlare?",
    chosen: (name: string) => `Ora parli con ${name}. /new inizia una nuova conversazione.`,
    newConversation: (name: string) => `Nuova conversazione con ${name}.`,
    help: "Scrivi per parlare con il tuo collega. /colleague per sceglierlo, /new per una nuova conversazione, /conversations per riprenderne o eliminarne una. Le approvazioni arrivano qui con i loro pulsanti.",
    noConversations: "Ancora nessuna conversazione: scrivi per iniziarne una.",
    conversations: "Le tue ultime conversazioni. Scegline una per continuarla, o 🗑 per eliminarla.",
    resumed: (title: string, name: string) => `Riprendi «${title}» con ${name}.`,
    confirmDelete: (title: string) =>
      `Eliminare «${title}» con tutti i suoi messaggi? Non si può annullare.`,
    deleteYes: "Elimina",
    deleteNo: "Annulla",
    deleted: "Conversazione eliminata.",
    kept: "Non ho eliminato nulla.",
    busy: "Il collega sta ancora rispondendo in quella conversazione: riprova quando ha finito.",
    gone: "Quella conversazione non esiste più.",
    untitled: "Senza titolo",
    needsProfile: "Questo collega non ha un profilo di modello utilizzabile: sceglilo in Orlok.",
    unavailable: "Questo collega non è disponibile al momento.",
    failed: "Il collega non è riuscito a rispondere. Apri Orlok per i dettagli.",
    approved: "Approvato.",
    approvedAlways: (types: string[]) =>
      `Consentito sempre per te, con tutti i tuoi colleghi, su ogni host: ${types.join(", ")}. Puoi revocarlo in Orlok → Account.`,
    denied: "Negato.",
    alreadyDecided: "Già deciso.",
    decideInApp: "Questa si decide in Orlok, non da Telegram.",
    notYours: "Può deciderla solo la persona per cui è stata chiesta.",
  },
} as const;

function text(locale: Locale | null | undefined) {
  return locale === "it" ? TEXT.it : TEXT.en;
}

async function accountByChat(db: Db, chatId: number) {
  const [row] = await db
    .select({ account: telegramAccounts, user: users })
    .from(telegramAccounts)
    .innerJoin(users, eq(telegramAccounts.userId, users.id))
    .where(eq(telegramAccounts.chatId, chatId))
    .limit(1);
  return row && !row.user.disabledAt ? row : null;
}

// The person's own colleagues and the colleague of each of their offices (R-ADM-8).
async function activeColleagues(db: Db, user: UserRow) {
  const rows = await db
    .select()
    .from(colleagues)
    .where(
      and(
        or(
          and(eq(colleagues.userId, user.id), eq(colleagues.officeWide, false)),
          eq(colleagues.officeWide, true),
        ),
        isNull(colleagues.deletedAt),
      ),
    )
    .orderBy(asc(colleagues.name));
  const me = toMe(user);
  const reachable = await Promise.all(
    rows.map((row) => (row.officeWide ? canAccessOffice(db, me, row.officeId) : true)),
  );
  return rows.filter((row, index) => isActive(row) && reachable[index]);
}

// Messages of one chat are handled in order, one turn at a time, without holding up the rest:
// a button pressed while an answer is being written must still be read at once.
const chatQueues = new Map<number, Promise<void>>();

function inChatOrder(chatId: number, work: () => Promise<void>) {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(work).catch((error: unknown) => {
    console.error("Telegram message failed", error);
  });
  chatQueues.set(chatId, next);
  void next.finally(() => {
    if (chatQueues.get(chatId) === next) {
      chatQueues.delete(chatId);
    }
  });
  return next;
}

export async function handleUpdate(deps: TelegramDeps, api: TelegramApi, update: TelegramUpdate) {
  if (update.callback_query) {
    await handleCallback(deps, api, update.callback_query);
    return;
  }
  const message = update.message;
  // Groups and channels would show private conversations to others: they are ignored.
  if (!message?.text || message.chat.type !== "private" || message.from?.is_bot) {
    return;
  }
  const chatId = message.chat.id;
  await inChatOrder(chatId, () => handleMessage(deps, api, message));
}

async function handleMessage(deps: TelegramDeps, api: TelegramApi, message: TelegramMessage) {
  const { db } = deps;
  const chatId = message.chat.id;
  const content = (message.text ?? "").trim();
  const start = /^\/start(?:@\w+)?\s+(\S+)/.exec(content);
  if (start?.[1]) {
    await link(deps, api, message, start[1]);
    return;
  }
  const found = await accountByChat(db, chatId);
  if (!found) {
    await api.sendMessage(chatId, text(null).unlinked);
    return;
  }
  const { account, user } = found;
  const t = text(user.locale);
  const command = /^\/(\w+)/.exec(content)?.[1]?.toLowerCase();
  if (command === "start" || command === "help") {
    await api.sendMessage(chatId, t.help);
    return;
  }
  if (command === "colleague" || command === "colleagues" || command === "collega") {
    await offerColleagues(db, api, chatId, user);
    return;
  }
  if (command === "conversations" || command === "conversazioni" || command === "chats") {
    await offerConversations(db, api, chatId, user.id, user.locale, account.conversationId);
    return;
  }

  // The colleague the chat talks to: the chosen one, or the only one the person has.
  let colleague = account.colleagueId
    ? (await activeColleagues(db, user)).find((item) => item.id === account.colleagueId)
    : undefined;
  if (!colleague) {
    const all = await activeColleagues(db, user);
    if (all.length !== 1) {
      await offerColleagues(db, api, chatId, user);
      return;
    }
    colleague = all[0];
    await db
      .update(telegramAccounts)
      .set({ colleagueId: colleague?.id ?? null, conversationId: null })
      .where(eq(telegramAccounts.userId, user.id));
  }
  if (!colleague) {
    return;
  }
  if (command === "new" || command === "nuova") {
    await db
      .update(telegramAccounts)
      .set({ conversationId: null })
      .where(eq(telegramAccounts.userId, user.id));
    await api.sendMessage(chatId, t.newConversation(colleague.name));
    return;
  }
  const target = await resolveColleagueModel(db, colleague);
  if (!target?.provider.enabled) {
    // The office colleague's profile is chosen by an administrator, not by the person (R-ADM-8).
    await api.sendMessage(chatId, colleague.officeWide ? t.unavailable : t.needsProfile);
    return;
  }

  // The conversation goes on until /new; a deleted one is replaced.
  let [conversation] = account.conversationId
    ? await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, account.conversationId),
            eq(conversations.colleagueId, colleague.id),
          ),
        )
    : [];
  if (!conversation) {
    [conversation] = await db
      .insert(conversations)
      .values({ colleagueId: colleague.id, userId: user.id, title: titleFromMessage(content) })
      .returning();
    if (!conversation) {
      return;
    }
    await db
      .update(telegramAccounts)
      .set({ conversationId: conversation.id })
      .where(eq(telegramAccounts.userId, user.id));
  }
  const [office] = await db.select().from(offices).where(eq(offices.id, colleague.officeId));
  if (!office) {
    return;
  }

  // One answer at a time in a conversation: this one waits for one being written (R-CHAT-13).
  let claim = runningTurns.claim(conversation.id);
  while (!claim) {
    await runningTurns.idle(conversation.id);
    claim = runningTurns.claim(conversation.id);
  }
  try {
    await db.insert(messages).values({ conversationId: conversation.id, role: "user", content });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  } catch (error) {
    claim.release();
    throw error;
  }
  const current = conversation;
  const me = toMe(user);
  // The answer reaches this chat when it ends, like any answer in the conversation it follows.
  await claim.run((signal, send) =>
    runColleagueTurn(deps, {
      conversation: current,
      colleague,
      office,
      user: me,
      retrievalText: content,
      signal,
      send,
    }),
  );
}

async function link(deps: TelegramDeps, api: TelegramApi, message: TelegramMessage, token: string) {
  const { db } = deps;
  const chatId = message.chat.id;
  const userId = await consumeLinkToken(db, token);
  if (!userId) {
    await api.sendMessage(chatId, text(null).linkInvalid);
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.disabledAt) {
    await api.sendMessage(chatId, text(null).linkInvalid);
    return;
  }
  const other = await accountByChat(db, chatId);
  if (other && other.user.id !== user.id) {
    await api.sendMessage(chatId, text(user.locale).otherAccount);
    return;
  }
  await db
    .insert(telegramAccounts)
    .values({ userId: user.id, chatId, username: message.from?.username ?? null })
    .onConflictDoUpdate({
      target: telegramAccounts.userId,
      set: { chatId, username: message.from?.username ?? null, linkedAt: new Date() },
    });
  await api.sendMessage(chatId, text(user.locale).linked(user.displayName));
}

async function offerColleagues(db: Db, api: TelegramApi, chatId: number, user: UserRow) {
  const all = await activeColleagues(db, user);
  const t = text(user.locale);
  if (all.length === 0) {
    await api.sendMessage(chatId, t.noColleagues);
    return;
  }
  await api.sendMessage(
    chatId,
    t.choose,
    all
      .slice(0, 30)
      .map((colleague) => [{ text: colleague.name, callback_data: `c:${colleague.id}` }]),
  );
}

// The person's latest conversations with their active colleagues, to continue (v:) or delete
// (x:, confirmed with X:). The one the chat follows now is marked.
async function offerConversations(
  db: Db,
  api: TelegramApi,
  chatId: number,
  userId: string,
  locale: Locale,
  currentId: string | null,
) {
  const t = text(locale);
  const rows = await db
    .select({ conversation: conversations, colleague: colleagues })
    .from(conversations)
    .innerJoin(colleagues, eq(conversations.colleagueId, colleagues.id))
    .where(and(eq(conversations.userId, userId), isNull(colleagues.deletedAt)))
    .orderBy(desc(conversations.updatedAt))
    .limit(30);
  const listed = rows.filter((row) => isActive(row.colleague)).slice(0, 10);
  if (listed.length === 0) {
    await api.sendMessage(chatId, t.noConversations);
    return;
  }
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  await api.sendMessage(
    chatId,
    t.conversations,
    listed.map(({ conversation, colleague }) => [
      {
        text: `${conversation.id === currentId ? "• " : ""}${conversation.title || t.untitled} · ${colleague.name} · ${day.format(conversation.updatedAt)}`.slice(
          0,
          64,
        ),
        callback_data: `v:${conversation.id}`,
      },
      { text: "🗑", callback_data: `x:${conversation.id}` },
    ]),
  );
}

async function ownConversation(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ conversation: conversations, colleague: colleagues })
    .from(conversations)
    .innerJoin(colleagues, eq(conversations.colleagueId, colleagues.id))
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
  return row && isActive(row.colleague) ? row : null;
}

// Buttons: c:<colleague> chooses; j:<job>:o|a|d approves once, always or denies a command;
// p:<plan>:a|s|d approves a plan, also always allowing its types, or denies it. Each press is
// checked again: the chat must belong to the person the request is for, and what is approved
// once each time is never approved from here.
async function handleCallback(deps: TelegramDeps, api: TelegramApi, query: TelegramCallbackQuery) {
  const { db } = deps;
  const chatId = query.message?.chat.id;
  const found = chatId === undefined ? null : await accountByChat(db, chatId);
  if (!found || found.account.chatId !== query.from.id) {
    await api.answerCallbackQuery(query.id, text(null).unlinked.slice(0, 190));
    return;
  }
  const { user } = found;
  const t = text(user.locale);
  const [kind, id, choice] = (query.data ?? "").split(":");
  if (kind === "c" && id) {
    const colleague = (await activeColleagues(db, user)).find((item) => item.id === id);
    if (colleague) {
      await db
        .update(telegramAccounts)
        .set({ colleagueId: colleague.id, conversationId: null })
        .where(eq(telegramAccounts.userId, user.id));
      await api.answerCallbackQuery(query.id);
      await api.sendMessage(found.account.chatId, t.chosen(colleague.name));
    } else {
      await api.answerCallbackQuery(query.id);
    }
    return;
  }
  if ((kind === "v" || kind === "x" || kind === "X" || kind === "n") && id !== undefined) {
    const chat = found.account.chatId;
    if (kind === "n") {
      await api.answerCallbackQuery(query.id, t.kept);
      return;
    }
    const row = id ? await ownConversation(db, user.id, id) : null;
    if (!row) {
      await api.answerCallbackQuery(query.id, t.gone);
      return;
    }
    const title = row.conversation.title || t.untitled;
    if (kind === "v") {
      await db
        .update(telegramAccounts)
        .set({ colleagueId: row.colleague.id, conversationId: row.conversation.id })
        .where(eq(telegramAccounts.userId, user.id));
      await api.answerCallbackQuery(query.id);
      await api.sendMessage(chat, t.resumed(title, row.colleague.name));
      // Where it was left: the last answer, so the person can pick up from there.
      await publishAnswer(deps, user.id, row.conversation.id);
      return;
    }
    if (kind === "x") {
      await api.answerCallbackQuery(query.id);
      await api.sendMessage(chat, t.confirmDelete(title), [
        [
          { text: t.deleteYes, callback_data: `X:${row.conversation.id}` },
          { text: t.deleteNo, callback_data: "n:" },
        ],
      ]);
      return;
    }
    // Confirmed: like deleting it in the app. Not while an answer is being written in it.
    if (runningTurns.isRunning(row.conversation.id)) {
      await api.answerCallbackQuery(query.id, t.busy.slice(0, 190));
      return;
    }
    await db.delete(conversations).where(eq(conversations.id, row.conversation.id));
    conversationChanged(row.conversation.userId, row.colleague.id, row.conversation.id, true);
    await api.answerCallbackQuery(query.id, t.deleted);
    if (query.message?.text) {
      await api
        .editMessageText(chat, query.message.message_id, `${query.message.text}\n\n${t.deleted}`)
        .catch(() => undefined);
    }
    return;
  }
  let outcome: string;
  if (kind === "j" && id && (choice === "o" || choice === "a" || choice === "d")) {
    const [job] = await db.select().from(opsJobs).where(eq(opsJobs.id, id));
    if (!job || job.requestedForUserId !== user.id) {
      outcome = t.notYours;
    } else if (job.status !== "pending_approval") {
      outcome = t.alreadyDecided;
    } else if (choice !== "d" && (job.targetKind === "mcp" || job.classification.onceOnly)) {
      outcome = t.decideInApp;
    } else if (choice === "a" && !job.classification.types?.length) {
      // Nothing to remember: "always" only exists for command types (R-OPS-4).
      outcome = t.decideInApp;
    } else {
      const decided = await decideJob(
        db,
        job.officeId,
        job.id,
        choice === "o" ? "once" : choice === "a" ? "always" : "deny",
        user.id,
      );
      outcome = decided
        ? choice === "d"
          ? t.denied
          : choice === "a"
            ? t.approvedAlways(job.classification.types ?? [])
            : t.approved
        : t.alreadyDecided;
    }
  } else if (kind === "p" && id && (choice === "a" || choice === "s" || choice === "d")) {
    const [plan] = await db.select().from(opsPlans).where(eq(opsPlans.id, id));
    const waiting = plan
      ? (await db.select().from(opsJobs).where(eq(opsJobs.planId, plan.id))).filter(
          (step) => step.status === "pending_approval",
        )
      : [];
    const onceOnly = waiting.some((step) => step.classification.onceOnly);
    // The types "always" remembers: those of the waiting steps, as in the app (R-OPS-4).
    const types = [...new Set(waiting.flatMap((step) => step.classification.types ?? []))];
    if (!plan || plan.requestedForUserId !== user.id) {
      outcome = t.notYours;
    } else if (plan.status !== "pending_approval") {
      outcome = t.alreadyDecided;
    } else if (choice !== "d" && onceOnly) {
      outcome = t.decideInApp;
    } else if (choice === "s" && types.length === 0) {
      outcome = t.decideInApp;
    } else {
      const decided = await decidePlan(
        db,
        plan.officeId,
        plan.id,
        choice === "a" ? "approve" : choice === "s" ? "approve_always" : "deny",
        user.id,
      );
      outcome = decided
        ? choice === "d"
          ? t.denied
          : choice === "s"
            ? t.approvedAlways(types)
            : t.approved
        : t.alreadyDecided;
    }
  } else {
    outcome = t.alreadyDecided;
  }
  await api.answerCallbackQuery(query.id, outcome);
  // The outcome replaces the buttons on this message and on any other asking the same.
  const settled = await settlePrompts(deps, api).catch(() => new Set<string>());
  if (query.message?.text && !settled.has(`${found.account.chatId}:${query.message.message_id}`)) {
    await api
      .editMessageText(
        found.account.chatId,
        query.message.message_id,
        `${query.message.text}\n\n${outcome}`,
      )
      .catch(() => undefined);
  }
}

// Long polling: asks Telegram for updates, one request at a time, and remembers the last one
// handled, so a restart neither loses nor repeats them. Without a configured bot it waits.
export function startTelegramWorker(deps: TelegramDeps) {
  let stopped = false;
  const controller = new AbortController();
  let currentToken: string | null = null;

  async function loop() {
    while (!stopped) {
      try {
        const bot = await getTelegramBot(deps.db, deps.config.secretKey);
        if (!bot) {
          currentToken = null;
          await sleep(30_000, controller.signal);
          continue;
        }
        const api = deps.telegram(bot.token);
        if (currentToken !== bot.token) {
          // Long polling and a webhook exclude each other.
          await api.deleteWebhook();
          await api.setMyCommands(COMMANDS.en).catch(() => undefined);
          await api.setMyCommands(COMMANDS.it, "it").catch(() => undefined);
          currentToken = bot.token;
        }
        // Decisions taken elsewhere without telling Telegram, e.g. cancelled requests.
        await settlePrompts(deps, api).catch((error: unknown) => {
          console.error("Telegram approval update failed", error);
        });
        const offset = await getOffset(deps.db);
        const updates = await api.getUpdates(offset, 25, controller.signal);
        for (const update of updates) {
          await setOffset(deps.db, update.update_id + 1);
          // Messages run in the background, in order per chat; buttons at once.
          const work = handleUpdate(deps, api, update).catch((error: unknown) => {
            console.error("Telegram update failed", error);
          });
          if (update.callback_query) {
            await work;
          }
        }
      } catch (error) {
        if (stopped) {
          break;
        }
        const wait =
          error instanceof TelegramError && error.retryAfter
            ? error.retryAfter * 1_000
            : error instanceof TelegramError && error.status === 409
              ? 30_000
              : 10_000;
        console.warn("Telegram polling failed", error instanceof Error ? error.message : error);
        await sleep(wait, controller.signal);
      }
    }
  }
  void loop();
  return () => {
    stopped = true;
    controller.abort();
  };
}

// The menu Telegram shows next to the message box: the commands are English in every language,
// only their descriptions are translated.
const COMMANDS = {
  en: [
    { command: "colleague", description: "Choose the colleague to talk with" },
    { command: "new", description: "Start a new conversation" },
    { command: "conversations", description: "Continue or delete a conversation" },
    { command: "help", description: "What this bot does" },
  ],
  it: [
    { command: "colleague", description: "Scegli il collega con cui parlare" },
    { command: "new", description: "Inizia una nuova conversazione" },
    { command: "conversations", description: "Riprendi o elimina una conversazione" },
    { command: "help", description: "Cosa fa questo bot" },
  ],
};

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
