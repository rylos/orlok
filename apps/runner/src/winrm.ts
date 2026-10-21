import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerTarget } from "@orlok/shared";
import { exitCodeOf, spawnManaged } from "./process";
import type { ExecutionContext, ExecutionResult } from "./ssh";

export type WinrmTarget = Extract<RunnerTarget, { kind: "winrm" }>;

// The helper (apps/runner/winrm/orlok_winrm.py) and the Python that has pypsrp.
export type WinrmBinaries = { python: string; helper: string };

const KNOWN_ERRORS = new Set(["auth_failed", "unreachable", "certificate_invalid", "winrm_error"]);

// Runs a PowerShell script on a Windows host over WinRM (R-OPS-2), as the runner user like SSH:
// the password reaches the helper through its environment, the script through a file of the
// job's private directory, and the outcome comes back as JSON in another one.
export async function runWinrmJob(
  ctx: ExecutionContext,
  binaries: WinrmBinaries,
  target: WinrmTarget,
  command: string,
): Promise<ExecutionResult> {
  const dir = await ctx.sandbox.privateDir();
  try {
    const script = path.join(dir, "script.ps1");
    const result = path.join(dir, "result.json");
    await writeFile(script, command, { mode: 0o600 });
    const env = {
      ...ctx.sandbox.baseEnv(dir),
      ORLOK_WINRM_HOST: target.host,
      ORLOK_WINRM_PORT: String(target.port),
      ORLOK_WINRM_USER: target.username,
      ORLOK_WINRM_PASSWORD: target.password,
      ORLOK_WINRM_SCHEME: target.https ? "https" : "http",
      ORLOK_WINRM_SCRIPT: script,
      ORLOK_WINRM_RESULT: result,
    };
    const run = await ctx.run(spawnManaged(binaries.python, ["-I", binaries.helper], { env }));
    if (run.info.error) {
      ctx.note(`The WinRM helper could not be started: ${run.info.error.message}\n`);
      return { exitCode: null, error: "spawn_failed", hostKey: null };
    }
    if (ctx.terminated()) {
      return { exitCode: exitCodeOf(run.info), error: null, hostKey: null };
    }
    const outcome = parseOutcome(await readFile(result, "utf8").catch(() => ""));
    if (!outcome) {
      return { exitCode: exitCodeOf(run.info), error: "winrm_error", hostKey: null };
    }
    return { exitCode: outcome.exitCode, error: outcome.error, hostKey: null };
  } finally {
    await ctx.sandbox.removePrivateDir(dir);
  }
}

export function parseOutcome(
  text: string,
): { exitCode: number | null; error: string | null } | null {
  try {
    const value = JSON.parse(text) as { exitCode?: unknown; error?: unknown };
    const exitCode =
      typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
        ? value.exitCode
        : null;
    const error =
      typeof value.error === "string"
        ? KNOWN_ERRORS.has(value.error)
          ? value.error
          : "winrm_error"
        : null;
    return { exitCode, error };
  } catch {
    return null;
  }
}
