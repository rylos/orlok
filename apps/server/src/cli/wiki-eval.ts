import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { eq, or } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { offices } from "../db/schema";
import { getLocalEmbedder } from "../embeddings-local";
import { createLlmClient } from "../llm";
import { embedderFor, semanticSearch } from "../services/embeddings";
import { searchPages } from "../services/wiki";
import {
  type EvalResult,
  evaluateSearch,
  evaluateTurns,
  parseEvalQuestions,
  parseEvalTurns,
} from "../services/wiki-eval";
import { conversationQuery, retrievePages } from "../services/wiki-retrieval";

// pnpm --filter @orlok/server wiki:eval --office <id or name> --questions <file.tsv>
// Measures each stage of wiki retrieval on one office: words alone, meaning alone (built-in
// embeddings, when the model files are there), and the final ranking colleagues get.
// With --turns <file.jsonl>, measures instead the pages given before each turn of real
// conversations: found, off-topic, and quiet when nothing should be given.
// Read-only: point it at a copy of the data, never at a production database.

const { values } = parseArgs({
  options: {
    database: { type: "string", default: process.env.DATABASE_URL },
    office: { type: "string" },
    questions: { type: "string" },
    turns: { type: "string" },
    k: { type: "string", default: "5" },
    "no-embeddings": { type: "boolean", default: false },
    misses: { type: "boolean", default: false },
  },
});

if (!values.database || !values.office || (!values.questions && !values.turns)) {
  console.error(
    "Usage: wiki:eval --office <id or name> (--questions <file.tsv> | --turns <file.jsonl>) [--database URL] [-k N] [--no-embeddings] [--misses]",
  );
  process.exit(2);
}

const k = Number(values.k);
const { db, close } = createDatabase(values.database);
const isUuid = /^[0-9a-f-]{36}$/i.test(values.office);
const [office] = await db
  .select({ id: offices.id, name: offices.name })
  .from(offices)
  .where(
    isUuid
      ? or(eq(offices.id, values.office), eq(offices.name, values.office))
      : eq(offices.name, values.office),
  );
if (!office) {
  console.error(`No office "${values.office}"`);
  process.exit(1);
}

// The built-in model, as the copied embeddings were made with it. No provider is ever called.
const embedder = values["no-embeddings"]
  ? null
  : await embedderFor(
      { db, llm: createLlmClient, localEmbedder: getLocalEmbedder, secretKey: Buffer.alloc(32) },
      { mode: "builtin", providerId: null, model: null },
    );

function report(label: string, result: EvalResult) {
  console.log(
    `${label.padEnd(10)} recall@1 ${percent(result.recallAt1)} · recall@${result.k} ${percent(result.recallAtK)} · MRR ${result.mrr.toFixed(3)}`,
  );
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`.padStart(4);
}

if (values.turns) {
  const turns = parseEvalTurns(await readFile(values.turns, "utf8"));
  const result = await evaluateTurns(turns, async (turn) =>
    (
      await retrievePages(db, office.id, conversationQuery(turn.message, turn.earlier), {
        embedder,
        limit: k,
      })
    ).map((page) => page.slug),
  );
  console.log(
    `${office.name}: ${result.turns} turns · found ${percent(result.recall)} · precision ${percent(result.precision)} · off-topic ${result.offTopicPerTurn.toFixed(2)}/turn · quiet ${percent(result.quietWhenNothing)} · ${result.pagesPerTurn.toFixed(1)} pages/turn`,
  );
  if (values.misses) {
    for (const miss of result.misses) {
      console.log(
        `- "${miss.message.replace(/\s+/g, " ").slice(0, 90)}"${miss.missing.length ? ` · missing ${miss.missing.join(", ")}` : ""}${miss.offTopic.length ? ` · off-topic ${miss.offTopic.join(", ")}` : ""}`,
      );
    }
  }
  await (await getLocalEmbedder())?.close();
  await close();
  process.exit(0);
}

const questions = parseEvalQuestions(await readFile(values.questions ?? "", "utf8"));
console.log(`${office.name}: ${questions.length} questions`);
const words = await evaluateSearch(
  questions,
  async (question) => (await searchPages(db, office.id, question, 20)).map((page) => page.slug),
  k,
);
report("words", words);
if (embedder) {
  const meaning = await evaluateSearch(
    questions,
    async (question) =>
      (await semanticSearch(db, office.id, embedder, question, 20)).map((page) => page.slug),
    k,
  );
  report("meaning", meaning);
}
const final = await evaluateSearch(
  questions,
  async (question) =>
    (await retrievePages(db, office.id, question, { embedder, limit: 20 })).map(
      (page) => page.slug,
    ),
  k,
);
report("final", final);
if (values.misses) {
  for (const miss of final.misses) {
    console.log(
      `- [${miss.rank ?? "—"}] "${miss.question}" → expected ${miss.expected}, first ${miss.top ?? "-"}`,
    );
  }
}
await (await getLocalEmbedder())?.close();
await close();
