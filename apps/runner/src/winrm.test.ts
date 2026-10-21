import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET_MARKER } from "./output";
import { createTestRunner } from "./test/helpers";
import { parseOutcome } from "./winrm";

// Windows hosts over WinRM (R-OPS-2), with a stand-in for the Python helper.

type Runner = Awaited<ReturnType<typeof createTestRunner>>;

describe("WinRM jobs", () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await createTestRunner();
  });

  afterAll(async () => {
    await runner.dispose();
  });

  const target = (password = "S3cret-win") => ({
    kind: "winrm" as const,
    host: "srv-win",
    port: 5985,
    username: "DOMAIN\\admin",
    password,
    https: false,
  });

  it("hands the script and the account to the helper and masks the password", async () => {
    const state = await runner.run({
      target: target(),
      command: "Get-Service W32Time",
      secrets: ["S3cret-win"],
    });
    expect(state).toMatchObject({ status: "done", exitCode: 0, error: null });
    expect(state.output).toContain("DOMAIN\\admin@srv-win:5985 http");
    expect(state.output).toContain("script: Get-Service W32Time");
    expect(state.output).toContain(`password: ${SECRET_MARKER}`);
    expect(state.output).not.toContain("S3cret-win");
  });

  it("reports the remote exit code and authentication failures", async () => {
    expect(await runner.run({ target: target(), command: "cmd /c exit 3" })).toMatchObject({
      status: "done",
      exitCode: 3,
    });
    expect(await runner.run({ target: target("wrong"), command: "hostname" })).toMatchObject({
      status: "failed",
      error: "auth_failed",
    });
  });

  it("refuses a target without a password", async () => {
    const res = await runner.submit({
      id: crypto.randomUUID(),
      target: { ...target(), password: "" },
      command: "hostname",
    });
    expect(res.status).toBe(400);
  });

  it("reads only known outcomes", () => {
    expect(parseOutcome('{"exitCode": 2, "error": null}')).toEqual({ exitCode: 2, error: null });
    expect(parseOutcome('{"exitCode": null, "error": "rm -rf"}')).toEqual({
      exitCode: null,
      error: "winrm_error",
    });
    expect(parseOutcome("not json")).toBeNull();
  });
});
