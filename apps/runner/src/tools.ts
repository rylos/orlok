import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Binaries the runner image is expected to provide (reported by /v1/health).
export const EXPECTED_TOOLS = [
  "sh",
  "ssh",
  "ssh-keyscan",
  "sshpass",
  "ping",
  "dig",
  "nslookup",
  "curl",
  "wget",
  "nmap",
  "mtr",
  "traceroute",
  "nc",
  "jq",
  "psql",
  "mariadb",
  "sqlcmd",
  "pwsh",
  "openssl",
  "whois",
  "rsync",
  "tcpdump",
  "snmpwalk",
  "ipmitool",
  "valkey-cli",
  "ldapsearch",
  "smbclient",
  "python3",
  "uv",
  "uvx",
  "git",
  "prlimit",
  "setpriv",
] as const;

export const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function findExecutable(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

// A derived image (`FROM orlok-runner`) declares the tools it adds, one name per line, in files
// under /etc/orlok-runner/tools.d/, or in ORLOK_RUNNER_EXTRA_TOOLS separated by commas. Only the
// ones really found on PATH are reported, so colleagues are never told about a missing tool.
export const EXTRA_TOOLS_DIR = "/etc/orlok-runner/tools.d";
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function declaredTools(dir: string, fromEnv: string | undefined): string[] {
  const names: string[] = (fromEnv ?? "").split(",");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => !file.startsWith("."));
  } catch {
    // No derived image.
  }
  for (const file of files.sort()) {
    try {
      names.push(...readFileSync(path.join(dir, file), "utf8").split("\n"));
    } catch {
      // Unreadable: ignored.
    }
  }
  return [
    ...new Set(
      names.map((name) => name.replace(/#.*/, "").trim()).filter((name) => TOOL_NAME.test(name)),
    ),
  ];
}

export function availableTools(searchPath: string, extra: string[] = []): string[] {
  const wanted = [...new Set([...EXPECTED_TOOLS, ...extra])];
  return wanted.filter((name) => findExecutable(name, searchPath) !== null);
}
