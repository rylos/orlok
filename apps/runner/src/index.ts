import os from "node:os";
import { serve } from "@hono/node-server";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { createRunnerApp } from "./app";
import { JobManager } from "./jobs";
import { McpSessionManager } from "./mcp";
import { Sandbox } from "./sandbox";
import {
  availableTools,
  DEFAULT_PATH,
  declaredTools,
  EXTRA_TOOLS_DIR,
  findExecutable,
} from "./tools";

// Only `pnpm dev` (NODE_ENV=development) may start without a configured token.
const DEV_TOKEN = "orlok-dev-runner-token";

const count = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  ORLOK_RUNNER_TOKEN: z.string().min(16).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  HOST: z.string().default("0.0.0.0"),
  PATH: z.string().default(DEFAULT_PATH),
  ORLOK_RUNNER_MAX_JOBS: z.coerce.number().int().min(1).default(8),
  ORLOK_RUNNER_MAX_MCP_SESSIONS: z.coerce.number().int().min(1).default(16),
  ORLOK_RUNNER_TMPDIR: z.string().default(os.tmpdir()),
  ORLOK_RUNNER_LIMIT_MEMORY_MB: count(4096),
  ORLOK_RUNNER_LIMIT_CPU_SECONDS: count(900),
  ORLOK_RUNNER_LIMIT_FILE_MB: count(1024),
  ORLOK_RUNNER_LIMIT_OPEN_FILES: count(1024),
  ORLOK_RUNNER_LIMIT_PROCESSES: count(256),
  ORLOK_RUNNER_SANDBOX_UID_BASE: z.coerce.number().int().min(1000).optional(),
  ORLOK_RUNNER_SANDBOX_LAUNCHER: z.string().default("/usr/local/libexec/orlok-setpriv"),
  // Python with pypsrp, and the helper that runs PowerShell over WinRM (R-OPS-2).
  ORLOK_RUNNER_WINRM_PYTHON: z.string().default("/opt/orlok-winrm/bin/python"),
  ORLOK_RUNNER_WINRM_HELPER: z.string().default("/usr/local/libexec/orlok_winrm.py"),
  // Tools a derived image adds, besides the files in /etc/orlok-runner/tools.d/.
  ORLOK_RUNNER_EXTRA_TOOLS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid runner configuration:", z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;
const token = env.ORLOK_RUNNER_TOKEN ?? (env.NODE_ENV === "development" ? DEV_TOKEN : undefined);
if (!token) {
  console.error("ORLOK_RUNNER_TOKEN is required (at least 16 characters).");
  process.exit(1);
}
// Children get explicit environments, but keep the token out of reach anyway.
delete process.env.ORLOK_RUNNER_TOKEN;

const maxJobs = env.ORLOK_RUNNER_MAX_JOBS;
const maxSessions = env.ORLOK_RUNNER_MAX_MCP_SESSIONS;

const sandbox = await Sandbox.create({
  tmpDir: env.ORLOK_RUNNER_TMPDIR,
  path: env.PATH,
  prlimit: findExecutable("prlimit", env.PATH),
  limits: {
    memoryMb: env.ORLOK_RUNNER_LIMIT_MEMORY_MB,
    cpuSeconds: env.ORLOK_RUNNER_LIMIT_CPU_SECONDS,
    fileSizeMb: env.ORLOK_RUNNER_LIMIT_FILE_MB,
    openFiles: env.ORLOK_RUNNER_LIMIT_OPEN_FILES,
    processes: env.ORLOK_RUNNER_LIMIT_PROCESSES,
  },
  isolation:
    env.ORLOK_RUNNER_SANDBOX_UID_BASE === undefined
      ? null
      : {
          launcher: env.ORLOK_RUNNER_SANDBOX_LAUNCHER,
          uidBase: env.ORLOK_RUNNER_SANDBOX_UID_BASE,
          slots: maxJobs + maxSessions,
        },
});
process.on("exit", () => sandbox.disposeSync());
if (!sandbox.isolated) {
  console.warn(
    "Runner sandbox isolation is off: local jobs run as the runner user " +
      "(set ORLOK_RUNNER_SANDBOX_UID_BASE in production).",
  );
}

const jobs = new JobManager({
  sandbox,
  maxJobs,
  ssh: {
    ssh: findExecutable("ssh", env.PATH) ?? "ssh",
    sshKeyscan: findExecutable("ssh-keyscan", env.PATH) ?? "ssh-keyscan",
    sshpass: findExecutable("sshpass", env.PATH) ?? "sshpass",
  },
  winrm: { python: env.ORLOK_RUNNER_WINRM_PYTHON, helper: env.ORLOK_RUNNER_WINRM_HELPER },
});
const mcp = new McpSessionManager({ sandbox, maxSessions });

const app = createRunnerApp({
  token,
  version: packageJson.version,
  jobs,
  mcp,
  tools: () =>
    availableTools(env.PATH, declaredTools(EXTRA_TOOLS_DIR, env.ORLOK_RUNNER_EXTRA_TOOLS)),
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`Orlok runner listening on http://${env.HOST}:${info.port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void Promise.all([jobs.shutdown(), mcp.shutdown()]).finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
