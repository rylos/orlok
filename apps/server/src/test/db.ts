import path from "node:path";
import { sql } from "drizzle-orm";
import type { Config } from "../config";
import { createDatabase, type Db } from "../db/client";
import { createLlmClient } from "../llm";
import { createMailer } from "../mail";
import type { RunnerClient } from "../ops/runner-client";
import type { PushSender } from "../services/push";
import { saveWikiSearchSettings } from "../services/wiki-search-settings";
import type { TelegramApiFactory } from "../telegram/api";

// Dedicated test database on the development Postgres instance (compose.dev.yaml).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://orlok:orlok@127.0.0.1:5432/orlok_test";

export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../../drizzle");

export function createTestDeps() {
  const { db, close } = createDatabase(TEST_DATABASE_URL);
  const config: Config = {
    env: "test",
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    secureCookies: false,
    secretKey: Buffer.alloc(32, 7),
    publicUrl: "http://orlok.test",
    runner: null,
    webDir: null,
    image: null,
  };
  // Tests never load the built-in embedding model.
  const localEmbedder = async () => null;
  // Tests that run commands pass a fake runner.
  const runner: RunnerClient | null = null;
  // Tests never reach real push services.
  const push: PushSender = async () => {};
  // Tests never reach Telegram: those that need it pass a fake.
  const telegram: TelegramApiFactory = () => {
    throw new Error("Telegram is not available in tests");
  };
  return {
    db,
    config,
    llm: createLlmClient,
    mail: createMailer,
    localEmbedder,
    runner,
    push,
    telegram,
    close,
  };
}

export async function resetDatabase(db: Db) {
  await db.execute(
    sql`truncate table audit_events, ops_jobs, mcp_servers, hosts, credentials, wiki_review_items, wiki_embeddings, wiki_sources, wiki_log, wiki_links, wiki_revisions, wiki_pages, invitation_offices, invitations, messages, conversations, colleagues, office_members, offices, sessions, settings, model_profiles, model_providers, users restart identity cascade`,
  );
  // Scripted models answer in order: a call writing the wiki search before each answer would take
  // their replies. Tests of that search turn it back on.
  await saveWikiSearchSettings(db, { queryRewrite: false, queryProfileId: null });
}
