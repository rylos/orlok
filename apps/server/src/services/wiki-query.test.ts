import { describe, expect, it } from "vitest";
import { parseQuery, queryPrompt } from "./wiki-query";

// The search written before a colleague answers (R-MEM-4).
describe("parseQuery", () => {
  it("reads the query, empty included, and nothing else", () => {
    expect(parseQuery('{"query": "app01 backup coda job"}')).toBe("app01 backup coda job");
    expect(parseQuery('```json\n{"query": "  "}\n```')).toBe("");
    expect(parseQuery("I cannot help with that.")).toBeNull();
    expect(parseQuery('{"search": "x"}')).toBeNull();
    expect(parseQuery('{"query": ')).toBeNull();
  });
});

describe("queryPrompt", () => {
  it("gives the wiki sections, the conversation and the latest message, shortened", () => {
    const prompt = queryPrompt({
      sections: ["Backup", "Infrastruttura"],
      title: "Nuovo server di posta",
      earlier: ["primo", "secondo", "terzo"],
      previousAnswer: `Fatto. ${"x".repeat(2_000)}`,
      message: "l'ha detto il tecnico",
    });
    expect(prompt).toContain("Wiki sections: Backup · Infrastruttura");
    expect(prompt).toContain("Conversation title: Nuovo server di posta");
    expect(prompt).not.toContain("<person>primo</person>");
    expect(prompt).toContain("<person>secondo</person>\n<person>terzo</person>");
    expect(prompt).toContain("<colleague>Fatto. x");
    expect(prompt.length).toBeLessThan(1_500);
    expect(prompt.endsWith("<latest_message>l'ha detto il tecnico</latest_message>")).toBe(true);
  });
});
