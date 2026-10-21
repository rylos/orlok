import { describe, expect, it } from "vitest";
import { explainReason } from "./ops-reasons";

describe("explainReason", () => {
  it.each([
    ["The command could not be fully parsed", "unparsed", {}],
    ["uses command substitution", "substitution", {}],
    ["uses `eval`", "keyword", { name: "eval" }],
    ["uses the call operator", "callOperator", {}],
    ["runs the interpreter `python3`", "interpreter", { program: "python3" }],
    ["`ssh` runs a command on another machine", "remote", { program: "ssh" }],
    ["runs the script `./deploy.sh`", "script", { program: "./deploy.sh" }],
    ["`cmd` runs code", "runsCode", { program: "cmd" }],
    ["`find -exec` runs another command", "runsCommand", { program: "find -exec" }],
    ["the sed script writes or runs a command", "toolScript", { program: "sed" }],
    ["the command name is a variable", "dynamicProgram", {}],
    ["`ForEach-Object` calls a member by name", "dynamicMember", {}],
    ["sets `LD_PRELOAD` before the command", "envVariable", { name: "LD_PRELOAD" }],
    ["sets `$ErrorActionPreference`", "specialVariable", { name: "$ErrorActionPreference" }],
    ["defines a function whose name has no dash", "function", {}],
    ["calls a .NET method", "dotnetMethod", {}],
    ["uses the .NET type `[System.Net.WebClient]`", "dotnetType", { type: "System.Net.WebClient" }],
    ["reads a sensitive path (`~/.ssh/id_rsa`)", "sensitivePath", { path: "~/.ssh/id_rsa" }],
    ["`Get-Credential` returns a secret", "secret", { program: "Get-Credential" }],
    ["`Remove-Item` was disabled by an administrator", "adminDisabled", { type: "Remove-Item" }],
    [
      "`Format-Volume` matches a forbidden pattern (formats a volume)",
      "forbidden",
      { program: "Format-Volume" },
    ],
    ["fork bomb", "forkBomb", {}],
  ])("%s", (reason, code, params) => {
    expect(explainReason(reason)).toEqual({ code, params });
  });

  it("lists the types to approve and why a read-only program needs approval", () => {
    expect(explainReason("`systemctl restart` needs approval")).toEqual({
      code: "needsApproval",
      params: { list: "systemctl restart" },
    });
    expect(explainReason("`>`, `sed` need approval (`sed -i` edits files in place)")).toEqual({
      code: "needsApproval",
      params: { list: ">, sed" },
      because: { code: "sedInPlace", params: {} },
    });
  });

  it("returns null for a text it does not know", () => {
    expect(explainReason("something new")).toBeNull();
  });
});
