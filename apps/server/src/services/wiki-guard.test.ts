import { describe, expect, it } from "vitest";
import { checkRewrite, countOccurrences, describeLosses } from "./wiki-guard";

describe("rewrite safeguards", () => {
  it("flags a long page cut to less than 70%", () => {
    const before = "x".repeat(2_000);
    expect(checkRewrite(before, "x".repeat(1_300)).shrunk).toBe(true);
    expect(checkRewrite(before, "x".repeat(1_500)).shrunk).toBe(false);
    // Short pages can be rewritten freely.
    expect(checkRewrite("x".repeat(500), "y").shrunk).toBe(false);
  });

  it("lists links, headings and literal values that disappeared", () => {
    const before =
      "## Rete\n\nweb01 → 10.0.1.10, verificato 2026-07-31, `ssh root@web01`. Vedi [[ups]].";
    const after = "## Server\n\nweb01 → 10.0.1.10.";
    const check = checkRewrite(before, after);
    expect(check.lostLinks).toEqual(["ups"]);
    expect(check.lostHeadings).toEqual(["## Rete"]);
    expect(check.lostFacts).toEqual(["2026-07-31", "`ssh root@web01`"]);
    expect(describeLosses(check)).toContain("[[ups]]");
    expect(describeLosses(checkRewrite(before, before))).toBeNull();
  });

  it("counts exact occurrences", () => {
    expect(countOccurrences("a b a b a", "a")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});
