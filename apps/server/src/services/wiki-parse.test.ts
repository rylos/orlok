import { parseWikiSynonyms } from "@orlok/shared";
import { describe, expect, it } from "vitest";
import { parseCheckFindings } from "./wiki-check";
import { evaluateSearch, parseEvalQuestions } from "./wiki-eval";
import { combineOutcomes, parseIngestOutcome } from "./wiki-ingest";
import { parseCandidates, transcriptOf } from "./wiki-reflect";

describe("answers of the model", () => {
  it("reads the outcome of an ingest analysis, new when unreadable", () => {
    expect(parseIngestOutcome("## Summary\nx\n\n## Outcome\nNothing: already written.")).toBe(
      "nothing",
    );
    expect(parseIngestOutcome("## Outcome — update")).toBe("update");
    expect(parseIngestOutcome("No heading at all")).toBe("new");
    expect(combineOutcomes(["nothing", "update", "new"])).toBe("update");
    expect(combineOutcomes(["nothing", "nothing"])).toBe("nothing");
  });

  it("keeps only findings quoted from the page, at most two", () => {
    const content = "The NAS  currently runs DSM 6.\nSince May: DSM 7.";
    const answer = `Here: ${JSON.stringify({
      issues: [
        { quote: "the nas currently runs dsm 6.", problem: "Contradicted below." },
        { quote: "Invented sentence.", problem: "x" },
        { quote: "Since May: DSM 7.", problem: "None" },
      ],
    })}`;
    expect(parseCheckFindings(answer, content)).toEqual([
      { quote: "the nas currently runs dsm 6.", problem: "Contradicted below." },
    ]);
    expect(parseCheckFindings("not json", content)).toEqual([]);
  });

  it("reads at most three proposals from a conversation", () => {
    const answer = JSON.stringify({
      candidates: [1, 2, 3, 4].map((n) => ({ title: `T${n}`, summary: "s" })),
    });
    expect(parseCandidates(answer).map((item) => item.title)).toEqual(["T1", "T2", "T3"]);
    expect(parseCandidates('{"candidates":[{"title":""}]}')).toEqual([]);
    expect(
      transcriptOf([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "" },
      ]),
    ).toBe("PERSON: Hi");
  });
});

describe("search evaluation", () => {
  it("parses questions and measures recall and MRR", async () => {
    const questions = parseEvalQuestions(
      "# comment\nvpn\tvpn,vpn-old\nups\tups\nnas\tnas\n\nbad\n",
    );
    expect(questions).toHaveLength(3);
    const results: Record<string, string[]> = {
      vpn: ["vpn-old", "x"],
      ups: ["x", "ups"],
      nas: ["x"],
    };
    const measured = await evaluateSearch(questions, async (q) => results[q] ?? [], 5);
    expect(measured).toMatchObject({ questions: 3, recallAt1: 1 / 3, recallAtK: 2 / 3 });
    expect(measured.mrr).toBeCloseTo((1 + 0.5) / 3);
    expect(measured.misses.map((miss) => miss.rank)).toEqual([2, null]);
  });

  it("parses synonym groups, one per line", () => {
    expect(parseWikiSynonyms("# ours\nvpn, tunnel\n\nlonely\n")).toEqual([["vpn", "tunnel"]]);
  });
});
