import { readFileSync } from "node:fs";
import { explainReason } from "@orlok/shared";
import { describe, expect, it } from "vitest";
import { classifyCommand } from "./classifier.js";

// Reasons people see only in the colleague's tools: a command that runs explains nothing.
const ALLOW_REASONS = new Set([
  "Approvals and blocks are disabled for this colleague",
  "Approvals are disabled for this colleague",
  "Only computes and prints values",
  "Every command is read-only or of an approved type",
  "dynamic",
]);

// Every reason the classifier can give, read from its source: the literal passed to setOpaque,
// unread, setDeny, a once-only piece or a decision, or returned by a helper. `${…}` becomes `x`.
function sourceReasons(): string[] {
  const source = readFileSync(new URL("./classifier.ts", import.meta.url), "utf8");
  const literal = String.raw`("(?:[^"\\]|\\.)*"|` + "`(?:[^`\\\\]|\\\\.|\\$\\{[^}]*\\})*`)";
  const sites = new RegExp(
    String.raw`(?:setOpaque\(|unread\(|setDeny\(|onceOnly: |opaque: |_ERROR = |script \? |\?\?= |return |decision\(\s*"\w+",\s*)` +
      literal,
    "g",
  );
  const reasons = new Set<string>();
  for (const match of source.matchAll(sites)) {
    const text = (match[1] ?? "")
      .slice(1, -1)
      .replace(/\$\{[^}]*\}/g, "x")
      .replace(/\\`/g, "`");
    if (/^[a-zA-Z`]/.test(text) && text.includes(" ")) reasons.add(text);
  }
  return [...reasons];
}

describe("classifier reasons", () => {
  it("finds the reasons in the source", () => {
    expect(sourceReasons().length).toBeGreaterThan(40);
  });

  it.each(sourceReasons().filter((r) => !ALLOW_REASONS.has(r)))("%s has a code", (reason) => {
    expect(explainReason(reason)).not.toBeNull();
  });

  it.each([
    ["$p = Get-Process; & $p", "powershell", "callOperator"],
    ["cmd /c dir", "powershell", "interpreter"],
    ["Invoke-Expression 'dir'", "powershell", "runsCode"],
    ["(Get-Process notepad).Kill()", "powershell", "dotnetMethod"],
    ["cat ~/.ssh/id_rsa", "posix", "sensitivePath"],
    ["systemctl restart nginx", "posix", "needsApproval"],
    ["mkfs.ext4 /dev/sda1", "posix", "forbidden"],
  ] as const)("%s (%s) explains as %s", (command, shell, code) => {
    const { reason } = classifyCommand(command, shell, { mode: "ask" });
    expect(explainReason(reason)?.code).toBe(code);
  });
});
