// Measures wiki search on questions with the page each one should find (R-MEM-4): how often the
// expected page comes first (recall@1), among the first k (recall@k), and the mean reciprocal rank.
// Changes to retrieval are judged with these numbers instead of by eye.

export type EvalQuestion = { question: string; expected: string[] };

export type EvalMiss = {
  question: string;
  rank: number | null;
  expected: string;
  top: string | null;
};

export type EvalResult = {
  questions: number;
  recallAt1: number;
  recallAtK: number;
  k: number;
  mrr: number;
  misses: EvalMiss[];
};

// One question per line: the question, a tab, the expected slugs separated by commas (finding any
// one counts). Empty lines and lines starting with # are ignored.
export function parseEvalQuestions(text: string): EvalQuestion[] {
  const questions: EvalQuestion[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const [question, slugs] = line.split("\t");
    const expected = (slugs ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    if (question?.trim() && expected.length > 0) {
      questions.push({ question: question.trim(), expected });
    }
  }
  return questions;
}

export async function evaluateSearch(
  questions: EvalQuestion[],
  search: (question: string) => Promise<string[]>,
  k = 5,
): Promise<EvalResult> {
  let first = 0;
  let inTopK = 0;
  let reciprocal = 0;
  const misses: EvalMiss[] = [];
  for (const { question, expected } of questions) {
    const found = await search(question);
    const index = found.findIndex((slug) => expected.includes(slug));
    const rank = index === -1 ? null : index + 1;
    if (rank === 1) {
      first += 1;
    }
    if (rank !== null && rank <= k) {
      inTopK += 1;
    }
    reciprocal += rank ? 1 / rank : 0;
    if (rank !== 1) {
      misses.push({ question, rank, expected: expected[0] ?? "", top: found[0] ?? null });
    }
  }
  const total = Math.max(1, questions.length);
  return {
    questions: questions.length,
    recallAt1: first / total,
    recallAtK: inTopK / total,
    k,
    mrr: reciprocal / total,
    misses,
  };
}

// Turns of real conversations with the pages that should be given before answering, and the
// pages of the same subject that do no harm (R-MEM-4). Recall alone rewards filling every slot:
// these also count the pages that have nothing to do with the conversation, and the turns where
// nothing should be given at all ("ciao").
export type EvalTurn = {
  title: string | null;
  earlier: string[];
  previousAnswer: string | null;
  message: string;
  expected: string[];
  acceptable: string[];
};

export type TurnMiss = { message: string; missing: string[]; offTopic: string[] };

export type TurnEvalResult = {
  turns: number;
  // Turns with expected pages where at least one of them was given.
  recall: number;
  // Given pages that were expected or acceptable.
  precision: number;
  // Pages given that have nothing to do with the conversation, per turn.
  offTopicPerTurn: number;
  // Turns where no page should be given at all and none was.
  quietWhenNothing: number;
  pagesPerTurn: number;
  misses: TurnMiss[];
};

// One JSON object per line; empty lines are ignored.
export function parseEvalTurns(text: string): EvalTurn[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value = JSON.parse(line) as Partial<EvalTurn>;
      return {
        title: value.title ?? null,
        earlier: value.earlier ?? [],
        previousAnswer: value.previousAnswer ?? null,
        message: value.message ?? "",
        expected: value.expected ?? [],
        acceptable: value.acceptable ?? [],
      };
    });
}

export async function evaluateTurns(
  turns: EvalTurn[],
  retrieve: (turn: EvalTurn) => Promise<string[]>,
): Promise<TurnEvalResult> {
  let withExpected = 0;
  let found = 0;
  let given = 0;
  let relevant = 0;
  let offTopic = 0;
  let nothingTurns = 0;
  let quiet = 0;
  const misses: TurnMiss[] = [];
  for (const turn of turns) {
    const pages = await retrieve(turn);
    const fitting = new Set([...turn.expected, ...turn.acceptable]);
    const wrong = pages.filter((slug) => !fitting.has(slug));
    given += pages.length;
    relevant += pages.length - wrong.length;
    offTopic += wrong.length;
    const missing =
      turn.expected.length > 0 && !pages.some((slug) => turn.expected.includes(slug))
        ? turn.expected
        : [];
    if (turn.expected.length > 0) {
      withExpected += 1;
      if (missing.length === 0) {
        found += 1;
      }
    }
    if (fitting.size === 0) {
      nothingTurns += 1;
      if (pages.length === 0) {
        quiet += 1;
      }
    }
    if (missing.length > 0 || wrong.length > 0) {
      misses.push({ message: turn.message, missing, offTopic: wrong });
    }
  }
  const total = Math.max(1, turns.length);
  return {
    turns: turns.length,
    recall: found / Math.max(1, withExpected),
    precision: given ? relevant / given : 1,
    offTopicPerTurn: offTopic / total,
    quietWhenNothing: nothingTurns ? quiet / nothingTurns : 1,
    pagesPerTurn: given / total,
    misses,
  };
}
