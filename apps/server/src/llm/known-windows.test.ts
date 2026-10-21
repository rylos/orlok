import { describe, expect, it } from "vitest";
import { knownContextWindow } from "./known-windows";

// A gateway in front of Claude that publishes no limits at all is the case this table exists
// for. What it must never do is answer for a model it does not know.

describe("windows we know without asking the provider", () => {
  it.each([
    ["claude-sonnet-5", 1_000_000],
    ["claude-opus-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-haiku-4-5-20251001", 200_000],
    ["claude-3-7-sonnet", 200_000],
    ["gemini-2.5-pro", 1_048_576],
    ["deepseek-flash", 1_000_000],
    ["deepseek-v4-pro", 1_000_000],
  ])("knows %s", (model, expected) => {
    expect(knownContextWindow(model)).toBe(expected);
  });

  it("reads the model through the spelling a provider happens to use", () => {
    // Google's OpenAI-compatible endpoint prefixes them, Anthropic dates its snapshots.
    expect(knownContextWindow("models/gemini-2.5-flash")).toBe(1_048_576);
    expect(knownContextWindow("claude-sonnet-5-20260514")).toBe(1_000_000);
    expect(knownContextWindow("  Claude-Opus-5  ")).toBe(1_000_000);
  });

  it("says nothing about a model it does not know", () => {
    // An answer invented here would be a conversation silently cut at the beginning.
    expect(knownContextWindow("gpt-4o")).toBeNull();
    expect(knownContextWindow("llama3.1:8b")).toBeNull();
    expect(knownContextWindow("mistral-large")).toBeNull();
    expect(knownContextWindow("")).toBeNull();
  });
});
