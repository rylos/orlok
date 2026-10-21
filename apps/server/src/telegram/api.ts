// Minimal Telegram Bot API client (R-CHAT-10): long polling, messages, inline buttons. Nothing is
// exposed to the internet: Orlok asks Telegram for updates, Telegram never calls Orlok.

export type TelegramUser = { id: number; is_bot: boolean; first_name: string; username?: string };
export type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type InlineButton = { text: string; callback_data?: string; url?: string };

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  deleteWebhook(): Promise<void>;
  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;
  // `html`: the text uses Telegram's HTML subset (see format.ts) instead of plain text.
  sendMessage(
    chatId: number,
    text: string,
    buttons?: InlineButton[][],
    options?: { html?: boolean },
  ): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  setMyCommands(
    commands: { command: string; description: string }[],
    languageCode?: string,
  ): Promise<void>;
}

export type TelegramApiFactory = (token: string) => TelegramApi;

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

// Telegram refuses messages over 4,096 characters.
export const TELEGRAM_MESSAGE_MAX = 4_096;

export const createTelegramApi: TelegramApiFactory = (token) => {
  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!data?.ok) {
      // The token is part of the URL: never include the URL in an error.
      throw new TelegramError(
        res.status,
        data?.description ?? `Telegram ${method} failed`,
        data?.parameters?.retry_after ?? null,
      );
    }
    return data.result as T;
  }
  return {
    getMe: () => call<TelegramUser>("getMe", {}),
    deleteWebhook: async () => {
      await call("deleteWebhook", { drop_pending_updates: false });
    },
    getUpdates: (offset, timeoutSeconds, signal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
        signal ?? AbortSignal.timeout((timeoutSeconds + 15) * 1_000),
      ),
    sendMessage: (chatId, text, buttons, options) =>
      call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        // HTML is never cut: a cut could leave a tag open.
        text: options?.html ? text : text.slice(0, TELEGRAM_MESSAGE_MAX),
        ...(options?.html ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      }),
    editMessageText: async (chatId, messageId, text) => {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, TELEGRAM_MESSAGE_MAX),
      });
    },
    answerCallbackQuery: async (id, text) => {
      await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
    },
    setMyCommands: async (commands, languageCode) => {
      await call("setMyCommands", {
        commands,
        ...(languageCode ? { language_code: languageCode } : {}),
      });
    },
  };
};

// Long answers are sent in pieces, cut at paragraph or line ends where possible.
export function splitMessage(text: string, max = TELEGRAM_MESSAGE_MAX): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
