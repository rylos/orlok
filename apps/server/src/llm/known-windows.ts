// Context windows of the model families we recognize, for the providers that publish none
// (R-MOD-6). A gateway like Meridian proxies Anthropic without repeating its metadata, and the
// OpenAI API never published it at all: the model is still the model, and its own documentation
// says how much it reads.
//
// Every row below is a number stated by the model's maker or carried by openclaw's provider
// catalogs. A family whose window nobody here can vouch for is deliberately absent: the field
// stays empty, and the administrator fills it in. Guessing it would be worse than not knowing,
// because a window guessed too large is a conversation quietly cut at the beginning.
//
// This is the lowest authority there is: what an administrator typed wins, then what the
// provider publishes, then this.

const FAMILIES: { pattern: RegExp; contextWindow: number; note: string }[] = [
  {
    // Claude 5 ships 1M as the model default, on every runtime.
    pattern: /^claude-(?:opus|sonnet|fable|mythos)-5(?:[.-]\d+)?(?:$|[^0-9])/,
    contextWindow: 1_000_000,
    note: "Claude 5 family",
  },
  {
    // Everything else Claude: the window Anthropic has shipped since Claude 3.
    pattern: /^claude-/,
    contextWindow: 200_000,
    note: "Claude, earlier generations",
  },
  {
    pattern: /^gemini-(?:2\.5|[3-9])/,
    contextWindow: 1_048_576,
    note: "Gemini 2.5 and later",
  },
  {
    pattern: /^deepseek-(?:flash|v4-pro)/,
    contextWindow: 1_000_000,
    note: "DeepSeek V4",
  },
];

// Providers spell the same model differently: "models/gemini-2.5-pro" on Google's OpenAI-compatible
// endpoint, a dated snapshot on Anthropic, upper case anywhere.
function family(modelId: string) {
  const bare = modelId.trim().toLowerCase().split("/").at(-1) ?? "";
  return bare.replace(/-\d{8}$/, "");
}

export function knownContextWindow(modelId: string): number | null {
  const id = family(modelId);
  return FAMILIES.find((entry) => entry.pattern.test(id))?.contextWindow ?? null;
}
