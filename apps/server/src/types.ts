import type { Me } from "@orlok/shared";
import type { Config } from "./config";
import type { Db } from "./db/client";
import type { LocalEmbedder } from "./embeddings-local";
import type { LlmClientFactory } from "./llm";
import type { MailerFactory } from "./mail";
import type { RunnerClient } from "./ops/runner-client";
import type { PushSender } from "./services/push";
import type { TelegramApiFactory } from "./telegram/api";

export type Deps = {
  db: Db;
  config: Config;
  // Injected so tests can replace real model providers and mail servers.
  llm: LlmClientFactory;
  mail: MailerFactory;
  // Built-in embedding model, loaded on first use; null when its files are missing.
  localEmbedder: () => Promise<LocalEmbedder | null>;
  // Runner service for colleague commands; null when not configured (R-OPS).
  runner: RunnerClient | null;
  // Web push delivery (R-CHAT-7); tests replace it.
  push: PushSender;
  // Telegram Bot API (R-CHAT-10); tests replace it.
  telegram: TelegramApiFactory;
};

export type AppEnv = {
  Variables: {
    user: Me | null;
    sessionToken: string | null;
  };
};
