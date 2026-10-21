// Operations: virtual colleagues run commands on the registered hosts and in the Orlok runner
// (R-OPS). Types shared by the server, the runner and the web app.

// --- Personal credentials (R-OPS-3) ---------------------------------------------------------

export const CREDENTIAL_KINDS = ["password", "ssh_key", "token"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

// A person's own credential: the colleagues working for that person use it on its hosts, so the
// target systems decide what they may do. The secret itself never leaves the server, except
// towards the runner for a single job.
export type Credential = {
  id: string;
  name: string;
  kind: CredentialKind;
  username: string | null;
  description: string | null;
  // Hosts it is used on, at most one credential per person per host. Always empty for a token,
  // which no colleague uses yet.
  hostIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
};

// --- Hosts (R-OPS-1, R-OPS-2) --------------------------------------------------------------

// One registry for the whole installation, kept by the administrators: a colleague reaches a host
// only with a credential that the person it works for stored for it.

// Windows servers are reached through OpenSSH in this version; WinRM comes later.
export const HOST_KINDS = ["linux", "windows"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

// How the runner reaches a host (R-OPS-2): SSH (OpenSSH on Windows too), or for Windows WinRM,
// over http with NTLM or Kerberos message encryption or over https with a verified certificate.
export const HOST_CONNECTIONS = ["ssh", "winrm", "winrm_https"] as const;
export type HostConnection = (typeof HOST_CONNECTIONS)[number];

export const DEFAULT_PORTS: Record<HostConnection, number> = {
  ssh: 22,
  winrm: 5985,
  winrm_https: 5986,
};

export type OpsHost = {
  id: string;
  name: string;
  kind: HostKind;
  connection: HostConnection;
  address: string;
  port: number;
  tags: string[];
  description: string | null;
  enabled: boolean;
  // SSH host key accepted on first connection ("type base64"), then enforced.
  hostKey: string | null;
  createdAt: string;
};

// --- Command rules and policies (R-OPS-4) --------------------------------------------------

export const SHELL_KINDS = ["posix", "powershell"] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

// A command is matched on its program name (glob, case-insensitive for PowerShell) and, when
// given, on its arguments joined by spaces (ECMAScript regex, must match the whole string).
export type CommandRule = {
  id: string;
  shell: ShellKind | "any";
  program: string;
  argPattern?: string;
  description: string;
};

export type CommandDecision = "allow" | "ask" | "deny";

export type CommandClassification = {
  decision: CommandDecision;
  // Short English explanation, shown to people and given to the model.
  reason: string;
  matchedRules: string[];
  programs: string[];
  // Set when a command asks in ask mode (since block 4): the command types the person has not
  // approved yet, and whether only "once" can be offered because the command cannot be read to
  // the end, reads a sensitive file or needs a type an administrator disabled.
  types?: string[];
  onceOnly?: boolean;
};

// How a colleague may run commands, set by its model profile (R-MOD-2, R-OPS-4). deny: no
// commands; ask: read-only commands and the types the person approved run, the rest asks; full:
// no approvals,
// blocked commands stay blocked; yolo: no approvals and blocked commands run too.
export const EXEC_MODES = ["deny", "ask", "full", "yolo"] as const;
export type ExecMode = (typeof EXEC_MODES)[number];

// A command type one person approved "always" (R-OPS-4, block 4): `systemctl restart`, `>`,
// `Restart-Service`. It spares that person the question with every colleague of theirs, on every
// host and on the runner, and nobody else: the judgement behind an approval is the approver's.
// Disabled by its owner it asks again; disabled by an administrator it asks once each time and
// stays so until an administrator enables it.
export type ApprovedCommandType = {
  id: string;
  userId: string;
  shell: ShellKind;
  type: string;
  disabledBy: "owner" | "admin" | null;
  createdAt: string;
};

// --- Plans (R-OPS-6) ------------------------------------------------------------------------

// Several commands proposed together: steps run in order, each only after the previous one
// succeeded; people approve the whole plan or its steps one by one.
export const OPS_PLAN_STATUSES = [
  "pending_approval",
  "running",
  "done",
  "failed",
  "denied",
  "stopped",
] as const;
export type OpsPlanStatus = (typeof OPS_PLAN_STATUSES)[number];

export const OPS_PLAN_MAX_STEPS = 20;

// "approve_always" also remembers the command types of the steps that can be read to the end.
export const PLAN_DECISIONS = ["approve", "approve_always", "deny"] as const;
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

export type OpsPlanRef = {
  id: string;
  title: string;
  summary: string | null;
  status: OpsPlanStatus;
  step: number;
  stepCount: number;
};

// --- Jobs and approvals (R-OPS-5, R-SEC-1) -------------------------------------------------

export const OPS_JOB_STATUSES = [
  "pending_approval",
  "queued",
  "running",
  "done",
  "failed",
  "timeout",
  "stopped",
  "denied",
  "expired",
] as const;
export type OpsJobStatus = (typeof OPS_JOB_STATUSES)[number];

export type OpsJobTarget =
  | { kind: "runner" }
  | { kind: "host"; id: string; name: string }
  | { kind: "mcp"; id: string; name: string; tool: string };

export type OpsJob = {
  id: string;
  officeId: string;
  colleague: { id: string; name: string } | null;
  conversationId: string | null;
  target: OpsJobTarget;
  shell: ShellKind;
  command: string;
  // MCP calls: the whole input as it will run, JSON with likely secrets masked.
  toolInput: string | null;
  // Why the colleague wants to run it.
  reason: string;
  classification: CommandClassification;
  // The plan this job is a step of, if any.
  plan: OpsPlanRef | null;
  status: OpsJobStatus;
  exitCode: number | null;
  // Combined stdout and stderr, with secrets masked.
  output: string;
  truncated: boolean;
  error: string | null;
  requestedFor: string | null;
  decidedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export const APPROVAL_CHOICES = ["once", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

// --- MCP servers (R-OPS-10) ----------------------------------------------------------------

// http: a remote MCP server (streamable HTTP); stdio: a local command run inside the runner.
export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

// readonly_auto: tools the server marks read-only run immediately, the others need approval.
export const MCP_TOOL_POLICIES = ["readonly_auto", "ask_all", "allow_all"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

export type McpToolInfo = {
  name: string;
  title: string | null;
  description: string | null;
  readOnly: boolean;
  destructive: boolean;
};

export type McpServer = {
  id: string;
  officeId: string;
  // Lowercase, used in tool names given to colleagues (mcp__<name>__<tool>).
  name: string;
  description: string | null;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  // Names of the stored secret values: HTTP headers or environment variables of the command.
  secretNames: string[];
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  // Every tool the server offers, as last listed.
  tools: McpToolInfo[];
  // The ones colleagues are given; null for all of them.
  allowedTools: string[] | null;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

// --- Runner API (internal, between the server and the runner container) ---------------------

export type RunnerSshAuth =
  | { type: "password"; password: string }
  | { type: "key"; privateKey: string; passphrase?: string };

export type RunnerTarget =
  | { kind: "local" }
  | {
      kind: "ssh";
      host: string;
      port: number;
      username: string;
      auth: RunnerSshAuth;
      // Expected host key ("type base64"); null accepts and reports the key on first use.
      knownHostKey: string | null;
      shell: ShellKind;
    }
  // Windows over WinRM (R-OPS-2): PowerShell, a password (NTLM or Kerberos), http with message
  // encryption or https with the certificate verified.
  | {
      kind: "winrm";
      host: string;
      port: number;
      username: string;
      password: string;
      https: boolean;
    };

export type RunnerJobRequest = {
  id: string;
  target: RunnerTarget;
  command: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  // Values replaced with [secret removed] in the output (credentials used by the job).
  secrets: string[];
};

export const RUNNER_JOB_STATUSES = ["running", "done", "failed", "timeout", "stopped"] as const;
export type RunnerJobStatus = (typeof RUNNER_JOB_STATUSES)[number];

export type RunnerJobState = {
  id: string;
  status: RunnerJobStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  // Host key observed on the SSH connection ("type base64").
  hostKey: string | null;
  // Machine-readable failure: "host_key_mismatch", "auth_failed", "unreachable", "spawn_failed".
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type RunnerStreamEvent =
  | { type: "output"; data: string }
  | { type: "end"; state: RunnerJobState };

export type RunnerMcpSession = {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type RunnerHealth = {
  ok: true;
  version: string;
  tools: string[];
};
