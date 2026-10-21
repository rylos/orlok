import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { promptTokens } from "./anthropic";

const usage = (fields: Partial<Anthropic.Usage>) =>
  ({ input_tokens: 0, output_tokens: 0, ...fields }) as Anthropic.Usage;

describe("prompt tokens", () => {
  it("counts what the cache served, not only what it did not", () => {
    // What a proxy with prompt caching on actually reports for a long conversation: a handful of
    // new tokens, the conversation itself under the cache fields. Reading input_tokens alone left
    // the context meter at nearly zero however long the conversation grew.
    expect(
      promptTokens(
        usage({
          input_tokens: 12,
          cache_creation_input_tokens: 4_000,
          cache_read_input_tokens: 56_000,
        }),
      ),
    ).toBe(60_012);
  });

  it("works where there is no cache at all", () => {
    expect(promptTokens(usage({ input_tokens: 1_500 }))).toBe(1_500);
  });
});
