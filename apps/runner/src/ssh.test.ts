import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { RunnerTarget } from "@orlok/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSshInvocation,
  classifySshFailure,
  parseKeyscan,
  powershellRemoteCommand,
  powershellScript,
} from "./ssh";
import { createTestRunner, sleep } from "./test/helpers";

describe("PowerShell command builder", () => {
  it("encodes the script as UTF-16LE base64", () => {
    const command = `Get-Service | Where-Object { $_.Name -eq "wuauserv" } # 'quotes' "à"`;
    const remote = powershellRemoteCommand(command);
    const match = /^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(
      remote,
    );
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match?.[1] as string, "base64").toString("utf16le");
    expect(decoded).toBe(powershellScript(command));
    expect(decoded.startsWith("$ProgressPreference='SilentlyContinue'\n")).toBe(true);
    // The command sits on its own line, so a trailing comment cannot swallow the exit handling.
    expect(decoded.split("\n")).toContain(command);
    expect(decoded).toContain("exit $global:LASTEXITCODE");
  });
});

describe("ssh invocation", () => {
  const base = {
    kind: "ssh" as const,
    host: "server.example",
    port: 2222,
    username: "admin",
    knownHostKey: null,
    shell: "posix" as const,
  };
  const binaries = { ssh: "ssh", sshKeyscan: "ssh-keyscan", sshpass: "sshpass" };
  const files = { knownHosts: "/tmp/kh", identity: "/tmp/id" };

  it("uses sshpass with the password in the environment only", () => {
    const target: Extract<RunnerTarget, { kind: "ssh" }> = {
      ...base,
      auth: { type: "password", password: "pw-secret" },
    };
    const invocation = buildSshInvocation({
      target,
      command: "uptime",
      files: { knownHosts: "/tmp/kh" },
      binaries,
      baseEnv: {},
    });
    expect(invocation.file).toBe("sshpass");
    expect(invocation.args.slice(0, 2)).toEqual(["-e", "ssh"]);
    expect(invocation.args.join(" ")).not.toContain("pw-secret");
    expect(invocation.env.SSHPASS).toBe("pw-secret");
    expect(invocation.args).toContain("BatchMode=no");
  });

  it("passes the command as one argument after the host", () => {
    const target: Extract<RunnerTarget, { kind: "ssh" }> = {
      ...base,
      auth: { type: "key", privateKey: "k" },
    };
    const invocation = buildSshInvocation({
      target,
      command: "-oProxyCommand=x; ls 'a b'",
      files,
      binaries,
      baseEnv: {},
    });
    expect(invocation.args.slice(-3)).toEqual([
      "--",
      "server.example",
      "-oProxyCommand=x; ls 'a b'",
    ]);
    expect(invocation.args).toContain("BatchMode=yes");
    expect(invocation.args).toContain("StrictHostKeyChecking=yes");
    expect(invocation.args).toContain("IdentitiesOnly=yes");
  });

  it("classifies ssh failures", () => {
    const classify = (exitCode: number, output: string) =>
      classifySshFailure({ exitCode, output, viaSshpass: false, rawBytes: output.length });
    expect(classify(255, "Host key verification failed.")).toBe("host_key_mismatch");
    expect(classify(255, "admin@host: Permission denied (publickey).")).toBe("auth_failed");
    expect(classify(255, "ssh: Could not resolve hostname nope")).toBe("unreachable");
    expect(classify(255, "connect to host x port 22: Connection refused")).toBe("unreachable");
    expect(classify(255, "connect to host x port 22: Connection timed out")).toBe("unreachable");
    expect(classify(255, "connect to host x port 22: No route to host")).toBe("unreachable");
    expect(classify(1, "Permission denied")).toBeNull();
    expect(classifySshFailure({ exitCode: 5, output: "", viaSshpass: true, rawBytes: 0 })).toBe(
      "auth_failed",
    );
  });

  it("prefers ed25519 host keys", () => {
    const output = [
      "# host:22 SSH-2.0-OpenSSH_9.9",
      "host ssh-rsa AAAAB3NzaC1yc2E=",
      "host ecdsa-sha2-nistp256 AAAAE2VjZHNh",
      "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
    ].join("\n");
    expect(parseKeyscan(output)).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5");
    expect(parseKeyscan("host ssh-rsa AAAAB3NzaC1yc2E=\n")).toBe("ssh-rsa AAAAB3NzaC1yc2E=");
    expect(parseKeyscan("")).toBeNull();
  });
});

const SSHD = "/usr/bin/sshd";

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number) {
  for (let i = 0; i < 100; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    await sleep(50);
  }
  throw new Error("sshd did not start");
}

describe.skipIf(!existsSync(SSHD))("ssh jobs against a local sshd", () => {
  let dir: string;
  let port: number;
  let sshd: ReturnType<typeof spawn>;
  let hostKey: string;
  let clientKey: string;
  let passphraseKey: string;
  let otherKey: string;
  let runner: Awaited<ReturnType<typeof createTestRunner>>;
  const username = os.userInfo().username;

  const keygen = async (name: string, passphrase = "") => {
    const file = path.join(dir, name);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "", "-f", file]);
    return {
      privateKey: await readFile(file, "utf8"),
      publicKey: (await readFile(`${file}.pub`, "utf8")).trim(),
    };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "orlok-runner-sshd-"));
    port = await freePort();
    const host = await keygen("host");
    hostKey = host.publicKey.split(" ").slice(0, 2).join(" ");
    const client = await keygen("client");
    const protectedKey = await keygen("protected", "correct horse");
    const other = await keygen("other");
    clientKey = client.privateKey;
    passphraseKey = protectedKey.privateKey;
    otherKey = other.privateKey;
    await writeFile(
      path.join(dir, "authorized_keys"),
      `${client.publicKey}\n${protectedKey.publicKey}\n`,
      { mode: 0o600 },
    );
    const config = [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(dir, "host")}`,
      `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
    ].join("\n");
    await writeFile(path.join(dir, "sshd_config"), `${config}\n`);
    sshd = spawn(SSHD, ["-D", "-e", "-f", path.join(dir, "sshd_config")], { stdio: "ignore" });
    await waitForPort(port);
    runner = await createTestRunner();
  });

  afterAll(async () => {
    await runner?.dispose();
    sshd?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  const target = (overrides: Partial<Extract<RunnerTarget, { kind: "ssh" }>> = {}) => ({
    kind: "ssh" as const,
    host: "127.0.0.1",
    port,
    username,
    auth: { type: "key" as const, privateKey: clientKey },
    knownHostKey: null,
    shell: "posix" as const,
    ...overrides,
  });

  it("runs a command with key auth and reports the host key on first use", async () => {
    const state = await runner.run({
      target: target(),
      command: "echo remote-ok; echo 'quoted arg'; exit 3",
      secrets: [clientKey],
    });
    expect(state).toMatchObject({ status: "done", exitCode: 3, error: null, hostKey });
    expect(state.output).toBe("remote-ok\nquoted arg\n");
  });

  it("verifies a known host key", async () => {
    const state = await runner.run({
      target: target({ knownHostKey: hostKey }),
      command: "echo ok",
    });
    expect(state).toMatchObject({ status: "done", exitCode: 0, hostKey, output: "ok\n" });
  });

  it("detects a host key mismatch and does not run the command", async () => {
    const marker = path.join(dir, "should-not-exist");
    const wrongKey = (await keygen("wrong-host")).publicKey.split(" ").slice(0, 2).join(" ");
    const state = await runner.run({
      target: target({ knownHostKey: wrongKey }),
      command: `touch ${marker}`,
    });
    expect(state).toMatchObject({ status: "failed", error: "host_key_mismatch", hostKey: null });
    expect(existsSync(marker)).toBe(false);
  });

  it("maps a rejected key to auth_failed", async () => {
    const state = await runner.run({
      target: target({ auth: { type: "key", privateKey: otherKey } }),
      command: "echo never",
    });
    expect(state).toMatchObject({ status: "failed", error: "auth_failed", exitCode: 255 });
  });

  it("unlocks passphrase-protected keys", async () => {
    const state = await runner.run({
      target: target({
        auth: { type: "key", privateKey: passphraseKey, passphrase: "correct horse" },
        knownHostKey: hostKey,
      }),
      command: "echo unlocked",
      secrets: ["correct horse"],
    });
    expect(state).toMatchObject({ status: "done", exitCode: 0, output: "unlocked\n" });
  });

  it("reports unreachable hosts", async () => {
    const closed = await freePort();
    const state = await runner.run({
      target: target({ port: closed, knownHostKey: hostKey }),
      command: "echo never",
    });
    expect(state).toMatchObject({ status: "failed", error: "unreachable" });
    const scanned = await runner.run({ target: target({ port: closed }), command: "echo never" });
    expect(scanned).toMatchObject({ status: "failed", error: "unreachable", hostKey: null });
  });
});
