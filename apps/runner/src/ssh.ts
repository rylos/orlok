import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerTarget } from "@orlok/shared";
import { type ExitInfo, exitCodeOf, type ManagedProcess, spawnManaged } from "./process";
import type { Sandbox } from "./sandbox";

export type SshTarget = Extract<RunnerTarget, { kind: "ssh" }>;

export type SshBinaries = { ssh: string; sshKeyscan: string; sshpass: string };

export type SshError = "host_key_mismatch" | "auth_failed" | "unreachable" | "spawn_failed";

// Known hosts entries are written for this alias, so host and port formats never matter.
export const HOST_KEY_ALIAS = "orlok-target";

export const HOST_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

const KEY_TYPE_PREFERENCE = ["ssh-ed25519", "ecdsa-sha2-", "ssh-rsa"];

// Picks the preferred host key from `ssh-keyscan` output, as "type base64".
export function parseKeyscan(output: string): string | null {
  const keys: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [, type, key] = trimmed.split(/\s+/);
    if (!type || !key) continue;
    const candidate = `${type} ${key}`;
    if (HOST_KEY_PATTERN.test(candidate)) keys.push(candidate);
  }
  for (const prefix of KEY_TYPE_PREFERENCE) {
    const found = keys.find((key) => key.startsWith(prefix));
    if (found) return found;
  }
  return null;
}

// Windows OpenSSH: the script travels base64-encoded (UTF-16LE), so no quoting layer (cmd.exe
// or PowerShell as DefaultShell) can alter it.
export function powershellScript(command: string): string {
  return [
    "$ProgressPreference='SilentlyContinue'",
    "$global:LASTEXITCODE = 0",
    command,
    "$orlokSucceeded = $?",
    "if (-not $orlokSucceeded) { if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }; exit 1 }",
    "exit 0",
  ].join("\n");
}

export function powershellRemoteCommand(command: string): string {
  const encoded = Buffer.from(powershellScript(command), "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

export type SshFiles = { knownHosts: string; identity?: string; askpass?: string };

export type SshInvocation = { file: string; args: string[]; env: Record<string, string> };

export function buildSshInvocation(options: {
  target: SshTarget;
  command: string;
  files: SshFiles;
  binaries: SshBinaries;
  baseEnv: Record<string, string>;
}): SshInvocation {
  const { target, files, binaries } = options;
  const auth = target.auth;
  const interactiveAuth = auth.type === "password" || Boolean(auth.passphrase);
  const sshOptions: Record<string, string> = {
    BatchMode: interactiveAuth ? "no" : "yes",
    ConnectTimeout: "10",
    ServerAliveInterval: "15",
    ServerAliveCountMax: "3",
    StrictHostKeyChecking: "yes",
    UserKnownHostsFile: files.knownHosts,
    GlobalKnownHostsFile: "/dev/null",
    HostKeyAlias: HOST_KEY_ALIAS,
    CheckHostIP: "no",
    UpdateHostKeys: "no",
    LogLevel: "ERROR",
    ForwardAgent: "no",
    ForwardX11: "no",
    ClearAllForwardings: "yes",
    PermitLocalCommand: "no",
    ControlMaster: "no",
    ControlPath: "none",
    IdentitiesOnly: "yes",
    IdentityAgent: "none",
  };
  if (auth.type === "key") {
    Object.assign(sshOptions, {
      PreferredAuthentications: "publickey",
      PasswordAuthentication: "no",
      KbdInteractiveAuthentication: "no",
    });
  } else {
    Object.assign(sshOptions, {
      PreferredAuthentications: "password,keyboard-interactive",
      PubkeyAuthentication: "no",
      NumberOfPasswordPrompts: "1",
    });
  }

  const remote =
    target.shell === "powershell" ? powershellRemoteCommand(options.command) : options.command;
  const sshArgs = [
    "-F",
    "/dev/null",
    "-T",
    "-n",
    ...Object.entries(sshOptions).flatMap(([name, value]) => ["-o", `${name}=${value}`]),
    ...(files.identity ? ["-i", files.identity] : []),
    "-p",
    String(target.port),
    "-l",
    target.username,
    // Nothing after "--" is parsed as an ssh option, whatever the host or command contain.
    "--",
    target.host,
    remote,
  ];

  const env = { ...options.baseEnv };
  if (auth.type === "password") {
    return {
      file: binaries.sshpass,
      args: ["-e", binaries.ssh, ...sshArgs],
      env: { ...env, SSHPASS: auth.password },
    };
  }
  if (auth.passphrase && files.askpass) {
    Object.assign(env, {
      SSH_ASKPASS: files.askpass,
      SSH_ASKPASS_REQUIRE: "force",
      ORLOK_SSH_PASSPHRASE: auth.passphrase,
    });
  }
  return { file: binaries.ssh, args: sshArgs, env };
}

// ssh exits with 255 for its own failures; the message tells which one it was.
export function classifySshFailure(options: {
  exitCode: number | null;
  output: string;
  viaSshpass: boolean;
  rawBytes: number;
}): SshError | null {
  const { exitCode, output } = options;
  // sshpass reports a rejected password (a second prompt) with 5 before any output arrives.
  if (options.viaSshpass && exitCode === 5 && options.rawBytes === 0) return "auth_failed";
  if (options.viaSshpass && exitCode === 6) return "host_key_mismatch";
  if (exitCode !== 255) return null;
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key type/i.test(
      output,
    )
  ) {
    return "host_key_mismatch";
  }
  if (/Permission denied|Too many authentication failures/.test(output)) return "auth_failed";
  if (
    /Could not resolve|Connection refused|timed out|No route to host|Network is unreachable/i.test(
      output,
    )
  ) {
    return "unreachable";
  }
  return null;
}

export type ExecutionContext = {
  sandbox: Sandbox;
  ssh: SshBinaries;
  // Runs a step of the job; output goes to the job unless captured.
  run(proc: ManagedProcess, capture?: boolean): Promise<{ info: ExitInfo; stdout: string }>;
  note(text: string): void;
  terminated(): boolean;
  output(): string;
  rawBytes(): number;
};

export type ExecutionResult = {
  exitCode: number | null;
  error: string | null;
  hostKey: string | null;
};

export async function runSshJob(
  ctx: ExecutionContext,
  target: SshTarget,
  command: string,
): Promise<ExecutionResult> {
  const dir = await ctx.sandbox.privateDir();
  try {
    const env = ctx.sandbox.baseEnv(dir);
    let hostKey = target.knownHostKey;
    if (hostKey === null) {
      const scan = await ctx.run(
        spawnManaged(
          ctx.ssh.sshKeyscan,
          ["-p", String(target.port), "-T", "10", "-t", "ed25519,ecdsa,rsa", "--", target.host],
          { env },
        ),
        true,
      );
      if (ctx.terminated()) return { exitCode: exitCodeOf(scan.info), error: null, hostKey: null };
      if (scan.info.error) {
        ctx.note(`ssh-keyscan could not be started: ${scan.info.error.message}\n`);
        return { exitCode: null, error: "spawn_failed", hostKey: null };
      }
      hostKey = parseKeyscan(scan.stdout);
      if (!hostKey) {
        ctx.note(`No SSH host key received from ${target.host} port ${target.port}.\n`);
        return { exitCode: null, error: "unreachable", hostKey: null };
      }
    }

    const files: SshFiles = { knownHosts: path.join(dir, "known_hosts") };
    await writeFile(files.knownHosts, `${HOST_KEY_ALIAS} ${hostKey}\n`, { mode: 0o600 });
    if (target.auth.type === "key") {
      files.identity = path.join(dir, "identity");
      // OpenSSH rejects keys with CRLF line endings or without a final newline.
      const key = `${target.auth.privateKey.replace(/\r\n/g, "\n").trimEnd()}\n`;
      await writeFile(files.identity, key, { mode: 0o600 });
      if (target.auth.passphrase) {
        files.askpass = path.join(dir, "askpass");
        await writeFile(files.askpass, '#!/bin/sh\nprintf "%s\\n" "$ORLOK_SSH_PASSPHRASE"\n', {
          mode: 0o700,
        });
      }
    }

    const invocation = buildSshInvocation({
      target,
      command,
      files,
      binaries: ctx.ssh,
      baseEnv: env,
    });
    const result = await ctx.run(
      spawnManaged(invocation.file, invocation.args, { env: invocation.env }),
    );
    if (result.info.error) {
      ctx.note(`ssh could not be started: ${result.info.error.message}\n`);
      return { exitCode: null, error: "spawn_failed", hostKey: null };
    }
    const exitCode = exitCodeOf(result.info);
    if (ctx.terminated()) return { exitCode, error: null, hostKey };
    const error = classifySshFailure({
      exitCode,
      output: ctx.output(),
      viaSshpass: target.auth.type === "password",
      rawBytes: ctx.rawBytes(),
    });
    return { exitCode, error, hostKey: error === "host_key_mismatch" ? null : hostKey };
  } finally {
    await ctx.sandbox.removePrivateDir(dir);
  }
}
