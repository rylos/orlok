import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase, runMigrations } from "./db/client";
import { getLocalEmbedder } from "./embeddings-local";
import { createLlmClient } from "./llm";
import { createMailer } from "./mail";
import { startOpsWorker } from "./ops/jobs";
import { createRunnerClient } from "./ops/runner-client";
import { deleteStaleAttachments } from "./services/chat-attachments";
import { continueAfterJob } from "./services/colleague-turn";
import { startEmbeddingWorker } from "./services/embeddings";
import { backfillContextWindows } from "./services/models";
import { notifyInterventionFinished } from "./services/notifications";
import { sendWebPush } from "./services/push";
import { startWikiIngestWorker } from "./services/wiki-ingest";
import { startWikiReflectWorker } from "./services/wiki-reflect";
import { startWikiLintWorker } from "./services/wiki-review";
import { createTelegramApi } from "./telegram/api";
import { startTelegramWorker } from "./telegram/bot";
import { withWebApp } from "./web-app";

const config = loadConfig();
const { db, close } = createDatabase(config.databaseUrl);

// From both src/ (development) and dist/ (build) the migrations folder is one level up.
await runMigrations(db, path.resolve(import.meta.dirname, "../drizzle"));

const deps = {
  db,
  config,
  llm: createLlmClient,
  mail: createMailer,
  localEmbedder: getLocalEmbedder,
  runner: config.runner ? createRunnerClient(config.runner) : null,
  push: sendWebPush,
  telegram: createTelegramApi,
};
// In production (Docker) the same process serves the built web app (R-PRD-1).
const api = createApp(deps);
const app = config.webDir ? withWebApp(api, config.webDir) : api;

// Documents uploaded to office wikis are filed by their colleague in the background.
const stopIngestWorker = startWikiIngestWorker(deps);
const stopEmbeddingWorker = startEmbeddingWorker(deps);
// Quiet conversations are read for knowledge worth proposing to the wiki.
const stopReflectWorker = startWikiReflectWorker(deps);
// Every office wiki is linted once a night, since conversations do not trigger it (R-MEM-7).
const stopLintWorker = startWikiLintWorker(db);
// Telegram (R-CHAT-10): long polling, only once a bot is configured.
const stopTelegramWorker = startTelegramWorker(deps);
// Profiles that predate the context window read it from their provider, when it publishes one.
backfillContextWindows(deps).catch((error: unknown) => {
  console.error("Reading the context windows of the model profiles failed", error);
});
// Commands approved after an answer ended run here; the colleague then continues the conversation.
const stopOpsWorker = startOpsWorker(deps, (job) => {
  notifyInterventionFinished(deps, job.id).catch((error: unknown) => {
    console.error("Notification after job failed", error);
  });
  setTimeout(() => {
    continueAfterJob(deps, job.id).catch((error: unknown) => {
      console.error("Follow-up after job failed", error);
    });
  }, 3_000);
});

// Attachments uploaded but never sent are removed after a day.
const attachmentCleanup = setInterval(() => {
  deleteStaleAttachments(db).catch((error: unknown) => {
    console.error("Attachment cleanup failed", error);
  });
}, 60 * 60_000);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Orlok server listening on http://localhost:${info.port}`);
});

function shutdown() {
  stopIngestWorker();
  stopEmbeddingWorker();
  stopReflectWorker();
  stopLintWorker();
  stopTelegramWorker();
  stopOpsWorker();
  clearInterval(attachmentCleanup);
  server.close(() => {
    void close().then(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
