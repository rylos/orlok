// --- Why a command asks or is refused, for people (R-OPS-4, block F2) ----------------------
//
// The classifier explains its decisions in short technical English, which the colleague reads
// to correct itself. People read a translated, plainer sentence instead: explainReason() turns
// the English text into a code and its details, and the web translates the code. Reading the
// stored text, not a new field, also explains jobs stored before the codes existed. A text no
// pattern knows returns null and is shown as it is.

export const OPS_REASON_CODES = [
  "commandsDisabled",
  "unparsed",
  "tooDeep",
  "empty",
  "substitution",
  "keyword",
  "interactive",
  "interpreter",
  "remote",
  "script",
  "runsCode",
  "runsCommand",
  "scriptBlock",
  "toolScript",
  "dynamicProgram",
  "dynamicMember",
  "dynamicType",
  "envVariable",
  "specialVariable",
  "function",
  "construct",
  "background",
  "assignment",
  "callOperator",
  "dotnetMethod",
  "dotnetType",
  "variablePath",
  "sensitivePath",
  "secret",
  "adminDisabled",
  "needsApproval",
  "sedInPlace",
  "findDelete",
  "download",
  "curl",
  "forbidden",
  "forkBomb",
  "rawDevice",
  "mcpTool",
] as const;
export type OpsReasonCode = (typeof OPS_REASON_CODES)[number];

export type OpsReasonExplanation = {
  code: OpsReasonCode;
  // Program, type, path or variable named by the reason, shown as code.
  params: Record<string, string>;
  // Why a read-only program needs approval this time: `cat` with `sed -i`, `curl -X POST`.
  because?: OpsReasonExplanation;
};

// Ordered: the first pattern that matches the whole text wins. Groups are named after params.
const PATTERNS: [RegExp, OpsReasonCode][] = [
  [/^Commands are disabled for this colleague$/, "commandsDisabled"],
  [/^The command could not be (?:fully )?parsed$/, "unparsed"],
  [/^nests too deeply$/, "tooDeep"],
  [/^No command to classify$/, "empty"],
  [/^uses (?:command|process) substitution$/, "substitution"],
  [/^uses an interactive `select`$/, "interactive"],
  [/^uses an unsupported shell construct$|^starts a coprocess$/, "construct"],
  [/^uses the call operator$/, "callOperator"],
  [/^uses `(?<name>.+)`$/, "keyword"],
  [/^runs the interpreter `(?<program>.+)`$/, "interpreter"],
  [/^`(?<program>.+)` runs a command on another machine$/, "remote"],
  [/^runs the script `(?<program>.+)`$/, "script"],
  [/^`(?<program>.+)` runs code$/, "runsCode"],
  [/^`(?<program>.+)` runs another command$/, "runsCommand"],
  [/^`(?<program>.+)` takes a script block that cannot be analysed$/, "scriptBlock"],
  [/^the (?<program>awk|sed) (?:program|script) .+$/, "toolScript"],
  [
    /^the (?:program|command) name (?:comes from an expansion|is a variable|is computed when it runs)$/,
    "dynamicProgram",
  ],
  [
    /^uses a (?:member|type) chosen when it runs$|^`ForEach-Object` calls a member by name$/,
    "dynamicMember",
  ],
  [/^the type of `(?<program>.+)` depends on a variable$/, "dynamicType"],
  [/^sets `(?<name>.+)` before the command$|^sets a shell variable$/, "envVariable"],
  [/^sets `(?<name>\$.+)`$/, "specialVariable"],
  [/^defines a function(?: .+)?$/, "function"],
  [/^runs in the background with `&`$/, "background"],
  [/^assigns a (?:property|value)$/, "assignment"],
  [/^calls a \.NET method$/, "dotnetMethod"],
  [/^uses the \.NET type `\[(?<type>.+)\]`$/, "dotnetType"],
  [/^reads a path through a variable$/, "variablePath"],
  [/^reads a sensitive path \(`(?<path>.+)`\)$/, "sensitivePath"],
  [/^`(?<program>.+)` returns a secret$/, "secret"],
  [/^`(?<type>.+)` was disabled by an administrator$/, "adminDisabled"],
  [/^`sed -i` edits files in place$/, "sedInPlace"],
  [/^`(?<program>find .+)` can run or delete$/, "findDelete"],
  [/^`(?<program>wget)` downloads to a file$/, "download"],
  [/^curl .+$/, "curl"],
  [/^`(?<program>.+)` matches a forbidden pattern \(.*\)$/s, "forbidden"],
  [/^fork bomb$/, "forkBomb"],
  [/^writes to a raw block device$/, "rawDevice"],
  [/^MCP tool that may change data, or the policy asks for approval$/, "mcpTool"],
];

// `a`, `b` need approval (because): the types the person has not approved yet.
const NEEDS_APPROVAL = /^(?<list>`.+`) needs? approval(?: \((?<because>.+)\))?$/s;

export function explainReason(reason: string): OpsReasonExplanation | null {
  const needs = NEEDS_APPROVAL.exec(reason);
  if (needs?.groups?.list) {
    const types = [...needs.groups.list.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    const because = needs.groups.because ? explainReason(needs.groups.because) : null;
    return {
      code: "needsApproval",
      params: { list: types.join(", ") },
      ...(because ? { because } : {}),
    };
  }
  for (const [pattern, code] of PATTERNS) {
    const match = pattern.exec(reason);
    if (match) return { code, params: { ...match.groups } };
  }
  return null;
}
