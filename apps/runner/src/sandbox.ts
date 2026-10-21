import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { type ManagedProcess, runCaptured, spawnManaged } from "./process";

// Applied with prlimit (soft = hard) to local jobs and MCP servers; 0 disables a limit.
export type ResourceLimits = {
  // RLIMIT_AS, virtual address space.
  memoryMb: number;
  // RLIMIT_CPU, local jobs only (MCP servers are long-lived).
  cpuSeconds: number;
  // RLIMIT_FSIZE, largest file a process may write.
  fileSizeMb: number;
  // RLIMIT_NOFILE.
  openFiles: number;
  // RLIMIT_NPROC; counted per user, so only applied when every job has its own uid.
  processes: number;
};

export type Isolation = {
  // setpriv binary allowed to switch uid (file capabilities cap_setuid,cap_setgid).
  launcher: string;
  uidBase: number;
  slots: number;
};

export type SandboxOptions = {
  tmpDir: string;
  limits: ResourceLimits;
  isolation: Isolation | null;
  path: string;
  prlimit: string | null;
};

export type SandboxedProcess = ManagedProcess & {
  readonly workDir: string;
  // Kills whatever is left of the process and deletes its working directory. Idempotent.
  release(): Promise<void>;
};

// Creates the working directory as the sandbox user, then execs the command inside it.
const ENTER_SCRIPT = 'umask 077 && mkdir -m 700 -- "$1" && cd -- "$1" && shift && exec "$@"';

// Runs as the job's uid: signals every process of that uid (the shell itself is spared).
const KILL_ALL_SCRIPT = 'kill -"$1" -1 2>/dev/null; exit 0';
const CLEANUP_SCRIPT =
  'kill -9 -1 2>/dev/null; kill -9 -1 2>/dev/null; chmod -R u+rwx -- "$1" 2>/dev/null; rm -rf -- "$1"';

export class Sandbox {
  readonly #options: SandboxOptions;
  readonly #root: string;
  readonly #usedSlots = new Set<number>();

  private constructor(options: SandboxOptions, root: string) {
    this.#options = options;
    this.#root = root;
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const root = await mkdtemp(path.join(options.tmpDir, "orlok-runner-"));
    // Other users may traverse the root but not list it.
    await chmod(root, options.isolation ? 0o711 : 0o700);
    await mkdir(path.join(root, "private"), { mode: 0o700 });
    await mkdir(path.join(root, "work"));
    // Sandbox users create their own directories here; the sticky bit stops them from removing
    // each other's, and missing read permission stops them from listing names.
    await chmod(path.join(root, "work"), options.isolation ? 0o1733 : 0o700);
    const sandbox = new Sandbox(options, root);
    if (options.isolation) await sandbox.#prepareIsolation(options.isolation);
    return sandbox;
  }

  get isolated() {
    return this.#options.isolation !== null;
  }

  get path() {
    return this.#options.path;
  }

  // Directory readable only by the runner user, for SSH keys and other job material.
  async privateDir(): Promise<string> {
    return mkdtemp(path.join(this.#root, "private", "job-"));
  }

  async removePrivateDir(dir: string) {
    await rm(dir, { recursive: true, force: true });
  }

  baseEnv(home: string): Record<string, string> {
    return { PATH: this.#options.path, HOME: home, TMPDIR: home, LANG: "C.UTF-8", TERM: "dumb" };
  }

  // Spawns `command` with the resource limits, in a fresh working directory, as a dedicated
  // uid when isolation is configured.
  spawn(options: {
    command: string[];
    env?: Record<string, string>;
    stdin?: "ignore" | "pipe";
    cpuLimit: boolean;
  }): SandboxedProcess {
    const workDir = path.join(this.#root, "work", randomBytes(16).toString("hex"));
    const env = { ...this.baseEnv(workDir), ...options.env };
    const inner = [
      "/bin/sh",
      "-c",
      ENTER_SCRIPT,
      "orlok-sandbox",
      workDir,
      ...this.#limitPrefix(options.cpuLimit),
      ...options.command,
    ];
    const isolation = this.#options.isolation;
    if (!isolation) {
      const proc = spawnManaged(inner[0] as string, inner.slice(1), {
        env,
        stdin: options.stdin,
      });
      let released: Promise<void> | undefined;
      const release = () => {
        released ??= proc.kill("SIGKILL").then(() => removeTree(workDir));
        return released;
      };
      return Object.assign(proc, { workDir, release });
    }

    const slot = this.#takeSlot(isolation);
    const uid = isolation.uidBase + slot;
    const proc = spawnManaged(isolation.launcher, [...launcherArgs(uid), ...inner], {
      env,
      stdin: options.stdin,
      kill: async (signal) => {
        await this.#runAs(uid, ["/bin/sh", "-c", KILL_ALL_SCRIPT, "kill", signalNumber(signal)]);
      },
    });
    let released: Promise<void> | undefined;
    const release = () => {
      released ??= this.#runAs(uid, ["/bin/sh", "-c", CLEANUP_SCRIPT, "cleanup", workDir]).then(
        () => {
          this.#usedSlots.delete(slot);
        },
      );
      return released;
    };
    return Object.assign(proc, { workDir, release });
  }

  // Removes everything the runner created; used on shutdown, also from exit handlers.
  disposeSync() {
    rmSync(path.join(this.#root, "private"), { recursive: true, force: true });
    if (!this.#options.isolation) rmSync(this.#root, { recursive: true, force: true });
  }

  #limitPrefix(cpuLimit: boolean): string[] {
    const { limits, prlimit, isolation } = this.#options;
    const values: [string, number][] = [
      ["as", limits.memoryMb * 1024 * 1024],
      ["cpu", cpuLimit ? limits.cpuSeconds : 0],
      ["fsize", limits.fileSizeMb * 1024 * 1024],
      ["nofile", limits.openFiles],
      ["nproc", isolation ? limits.processes : 0],
    ];
    const active = values.filter(([, value]) => value > 0);
    if (active.length === 0) return [];
    if (prlimit) {
      return [prlimit, ...active.map(([name, value]) => `--${name}=${value}:${value}`), "--"];
    }
    // Fallback without util-linux: ulimit sets the limit for the shell that execs the command.
    const flags: Record<string, (value: number) => string> = {
      as: (v) => `-v ${Math.floor(v / 1024)}`,
      cpu: (v) => `-t ${v}`,
      fsize: (v) => `-f ${Math.floor(v / 1024)}`,
      nofile: (v) => `-n ${v}`,
      nproc: (v) => `-u ${v}`,
    };
    const script = active
      .map(([name, value]) => `ulimit ${flags[name]?.(value)}`)
      .concat('exec "$@"')
      .join(" && ");
    return ["/bin/sh", "-c", script, "orlok-limits"];
  }

  #takeSlot(isolation: Isolation) {
    for (let slot = 0; slot < isolation.slots; slot++) {
      if (!this.#usedSlots.has(slot)) {
        this.#usedSlots.add(slot);
        return slot;
      }
    }
    throw new Error("No free sandbox user");
  }

  async #runAs(uid: number, command: string[]) {
    const launcher = this.#options.isolation?.launcher as string;
    return runCaptured(launcher, [...launcherArgs(uid), ...command], {
      PATH: this.#options.path,
      LANG: "C.UTF-8",
    });
  }

  async #prepareIsolation(isolation: Isolation) {
    const probe = await this.#runAs(isolation.uidBase, ["/bin/sh", "-c", "id -u"]);
    if (probe.stdout.trim() !== String(isolation.uidBase)) {
      throw new Error(
        `Sandbox launcher ${isolation.launcher} cannot switch to uid ${isolation.uidBase} ` +
          `(needs CAP_SETUID and CAP_SETGID): ${probe.error?.message ?? probe.stderr.trim()}`,
      );
    }
    // Leftovers of a previous runner process in the same container.
    await Promise.all(
      Array.from({ length: isolation.slots }, (_, slot) =>
        this.#runAs(isolation.uidBase + slot, ["/bin/sh", "-c", KILL_ALL_SCRIPT, "kill", "9"]),
      ),
    );
  }
}

function launcherArgs(uid: number) {
  return [
    `--reuid=${uid}`,
    `--regid=${uid}`,
    "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--",
  ];
}

function signalNumber(signal: "SIGTERM" | "SIGKILL") {
  return signal === "SIGKILL" ? "9" : "15";
}

async function removeTree(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // A job may have removed permissions from its own directories.
    await runCaptured("chmod", ["-R", "u+rwx", "--", dir], { PATH: process.env.PATH ?? "" });
    await rm(dir, { recursive: true, force: true });
  }
}
