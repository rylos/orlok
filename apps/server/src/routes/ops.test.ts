import type {
  ApiError,
  ApprovedCommandType,
  Colleague,
  Conversation,
  ConversationListItem,
  ConversationSummary,
  Credential,
  ExecMode,
  ModelProfile,
  ModelProvider,
  Office,
  OpsHost,
  OpsJob,
  RunnerJobRequest,
  RunnerJobState,
} from "@orlok/shared";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { auditEvents, credentials, hosts, opsJobs, profileGrants, users } from "../db/schema";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { claimJob, executeJob, findJobRow, type JobTarget, requestJob } from "../ops/jobs";
import type { RunnerClient } from "../ops/runner-client";
import { OPS_WAITS } from "../ops/tools";
import { continueAfterJob } from "../services/colleague-turn";
import { liveEvents } from "../services/live-events";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

const deps = createTestDeps();
const requests: ChatRequest[] = [];
let script: ChatChunk[][] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push({ ...request, messages: [...request.messages] });
    for (const chunk of script.shift() ?? [{ type: "text", text: "OK" }]) {
      yield chunk;
    }
    yield { type: "done", stopReason: "end_turn", usage: null };
  },
});

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey";
const runs: RunnerJobRequest[] = [];
// Output the runner reports while a job still runs, and what the job row held right after.
let progress: string | null = null;
let savedWhileRunning: { status: string; output: string | null } | undefined;
// What the runner reports at the end instead of the usual echo of the command.
let finalOutput: string | null = null;
const fakeRunner: RunnerClient = {
  async health() {
    return { ok: true, version: "test", tools: ["ssh", "ping"] };
  },
  async start(request) {
    runs.push(request);
  },
  async get(id) {
    return state(id);
  },
  async stop() {},
  async mcpOpen() {},
  async mcpSend() {},
  async mcpEvents() {},
  async mcpClose() {},
  async wait(id, options) {
    if (progress !== null && options.onProgress) {
      await options.onProgress({
        ...state(id),
        status: "running",
        exitCode: null,
        finishedAt: null,
        output: progress,
      });
      [savedWhileRunning] = await deps.db
        .select({ status: opsJobs.status, output: opsJobs.output })
        .from(opsJobs)
        .where(eq(opsJobs.id, id));
    }
    return state(id);
  },
};

function state(id: string): RunnerJobState {
  const request = runs.find((item) => item.id === id);
  return {
    id,
    status: "done",
    exitCode: 0,
    output: finalOutput ?? `ran: ${request?.command}\npassword=hunter22 leaked`,
    truncated: false,
    hostKey: HOST_KEY,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

const opsDeps = { ...deps, llm: fakeLlm, runner: fakeRunner };
const app = createApp(opsDeps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  runs.length = 0;
  progress = null;
  finalOutput = null;
  savedWhileRunning = undefined;
  script = [];
  OPS_WAITS.approvalMs = 5_000;
  OPS_WAITS.runMs = 5_000;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

function execCall(input: Record<string, unknown>, id = "exec"): ChatChunk {
  return { type: "tool_calls", calls: [{ id, name: "ops_exec", input }] };
}

async function setup() {
  const provider = await call<ModelProvider>("/admin/providers", "POST", {
    name: "Provider",
    kind: "anthropic",
    apiKey: "x",
  });
  const { id: profileId } = (
    await call<{ id: string }>("/admin/profiles", "POST", {
      name: "Profile",
      providerId: provider.body.id,
      model: "model",
      mode: "ask",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Sysadmin",
    })
  ).body;
  const host = await call<OpsHost>("/admin/hosts", "POST", {
    name: "app03",
    kind: "linux",
    address: "10.0.0.30",
    tags: ["proxmox"],
  });
  // The administrator chats with the colleague in most tests, so the credential is theirs.
  const credential = await call<Credential>("/me/credentials", "POST", {
    name: "root app03",
    kind: "password",
    username: "root",
    secret: "S3cret-root-pass",
    hostIds: [host.body.id],
  });
  return { office, colleague, credential: credential.body, host: host.body };
}

// A password credential of whoever the cookie belongs to, for the given hosts.
async function storeCredential(
  cookie: string,
  input: { name: string; username: string; secret: string; hostIds: string[] },
) {
  return call<Credential>("/me/credentials", "POST", { kind: "password", ...input }, cookie);
}

// Moves the colleague onto a profile of the same model with another mode, granted to the
// administrator who owns it (R-MOD-2).
async function useMode(colleague: Colleague, mode: ExecMode) {
  const profiles = (await call<ModelProfile[]>("/admin/profiles")).body;
  const current = profiles.find((profile) => profile.id === colleague.profileId);
  const created = await call<ModelProfile>("/admin/profiles", "POST", {
    name: `Profile ${mode}`,
    providerId: current?.providerId,
    model: current?.model,
    mode,
  });
  expect(created.res.status).toBe(201);
  const admin = (await call<{ id: string }>("/me")).body;
  await deps.db.insert(profileGrants).values({ userId: admin.id, profileId: created.body.id });
  const moved = await call(`/colleagues/${colleague.id}`, "PATCH", { profileId: created.body.id });
  expect(moved.res.status).toBe(200);
}

async function startChat(colleagueId: string, content: string, cookie = adminCookie) {
  const conversation = await call<ConversationSummary>(
    "/conversations",
    "POST",
    { colleagueId },
    cookie,
  );
  const res = await app.request(
    `/api/conversations/${conversation.body.id}/messages`,
    jsonRequest("POST", { content }, cookie),
  );
  return { conversationId: conversation.body.id, res };
}

describe("operations", () => {
  it("keeps secrets out of the API and trusts the host key on the first test", async () => {
    const { credential, host } = await setup();
    expect(credential).not.toHaveProperty("secret");
    expect(credential.hostIds).toEqual([host.id]);
    const [row] = await deps.db.select().from(credentials).where(eq(credentials.id, credential.id));
    expect(row?.secretEncrypted).not.toContain("S3cret-root-pass");

    const tested = await call<{ ok: boolean; output: string }>(
      `/me/credentials/${credential.id}/test`,
      "POST",
      { hostId: host.id },
    );
    expect(tested.body.ok).toBe(true);
    expect(runs[0]).toMatchObject({
      target: {
        kind: "ssh",
        host: "10.0.0.30",
        port: 22,
        username: "root",
        auth: { type: "password", password: "S3cret-root-pass" },
        knownHostKey: null,
        shell: "posix",
      },
      secrets: ["S3cret-root-pass"],
    });
    const [listed] = (await call<OpsHost[]>("/admin/hosts")).body;
    expect(listed?.hostKey).toBe(HOST_KEY);

    // Hosts and credentials belong to no office: their events are in the installation log.
    const events = await deps.db.select().from(auditEvents);
    expect(events.map((event) => [event.action, event.officeId]).sort()).toEqual([
      ["credential.create", null],
      ["host.create", null],
      ["host.test", null],
    ]);
    expect(JSON.stringify(events)).not.toContain("S3cret-root-pass");
  });

  it("runs read-only commands right away and records them on the answer", async () => {
    const { office, colleague } = await setup();

    script = [
      [
        { type: "text", text: "Let me look." },
        execCall({ target: "app03", command: "uptime", reason: "Check the load" }),
      ],
      [{ type: "text", text: "The server is up." }],
    ];
    const { conversationId, res } = await startChat(colleague.id, "Is app03 alive?");
    const events = parseSse(await res.text());

    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["ops_targets", "ops_exec", "ops_job"]),
    );
    expect(requests[0]?.system).toContain("<operations>");
    expect(runs[0]).toMatchObject({ command: "uptime", target: { kind: "ssh" } });

    const toolResult = requests[1]?.messages.at(-1);
    expect(toolResult).toMatchObject({ role: "tool", results: [{ isError: false }] });
    const content = toolResult?.role === "tool" ? toolResult.results[0]?.content : "";
    expect(content).toContain("ran: uptime");
    expect(content).toContain("password=[secret removed]");
    expect(content).not.toContain("hunter22");

    const jobEvents = events.filter((event) => event.type === "ops_job");
    expect(jobEvents.at(-1)).toMatchObject({ job: { status: "done", command: "uptime" } });
    const stored = await call<Conversation>(`/conversations/${conversationId}`);
    const answer = stored.body.messages.at(-1);
    const jobIds = answer?.opsJobIds ?? [];
    expect(jobIds).toHaveLength(1);
    // The answer keeps the order it happened in: what was said before the command, the command,
    // then what was said about it (R-CHAT-4).
    expect(answer?.parts).toEqual([
      { type: "text", text: "Let me look." },
      { type: "job", jobId: jobIds[0] },
      { type: "text", text: "The server is up." },
    ]);
    const jobs = await call<OpsJob[]>(`/offices/${office.id}/ops/jobs?ids=${jobIds.join(",")}`);
    expect(jobs.body[0]).toMatchObject({
      status: "done",
      target: { kind: "host", name: "app03" },
      classification: { decision: "allow" },
    });

    // A later turn is told how the commands of the earlier answer ended (R-OPS-5): without it the
    // colleague has only its own words about them, and calls a finished command still pending.
    script = [[{ type: "text", text: "Nothing else." }]];
    const again = await app.request(
      `/api/conversations/${conversationId}/messages`,
      jsonRequest("POST", { content: "And now?" }, adminCookie),
    );
    // The turn only runs while its stream is being read.
    await again.text();
    const history = requests.at(-1)?.messages ?? [];
    const results = history.flatMap((message) =>
      message.role !== "tool" &&
      typeof message.content === "string" &&
      message.content.includes("<ops_job_results>")
        ? [message.content]
        : [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("ran: uptime");
  });

  it("saves the output of a running command for its card, secrets masked", async () => {
    const { colleague } = await setup();
    progress = "line 1\nline 2\npassword=hunter22\n";
    script = [
      [execCall({ target: "app03", command: "uptime", reason: "Check the load" })],
      [{ type: "text", text: "Done." }],
    ];
    const { res } = await startChat(colleague.id, "Is app03 alive?");
    await res.text();

    expect(savedWhileRunning).toEqual({
      status: "running",
      output: "line 1\nline 2\npassword=[secret removed]\n",
    });
    // The result replaces it once the command ends.
    const toolResult = requests[1]?.messages.at(-1);
    const content = toolResult?.role === "tool" ? toolResult.results[0]?.content : "";
    expect(content).toContain("ran: uptime");
    expect(content).not.toContain("line 2");
  });

  it("stores the output of a command that prints NUL bytes", async () => {
    const { colleague } = await setup();
    // A binary file read as text: Postgres text cannot hold NUL, the job must still end.
    progress = "PROP sw_component = \u0000\u0005\u0000?";
    finalOutput = "part\u0000name";
    script = [
      [execCall({ target: "app03", command: "strings firmware.bin", reason: "Read the file" })],
      [{ type: "text", text: "Done." }],
    ];
    const { res } = await startChat(colleague.id, "What is in the part?");
    await res.text();

    expect(savedWhileRunning?.output).toBe("PROP sw_component = \uFFFD\u0005\uFFFD?");
    const [job] = await deps.db.select().from(opsJobs).orderBy(desc(opsJobs.createdAt)).limit(1);
    expect(job?.status).toBe("done");
    expect(job?.output).toBe("part\uFFFDname");
  });

  it("refuses a PowerShell command wrapped in another PowerShell", async () => {
    const { office, colleague } = await setup();
    const windowsHost = await call<OpsHost>("/admin/hosts", "POST", {
      name: "app01",
      kind: "windows",
      address: "10.0.0.40",
    });
    await storeCredential(adminCookie, {
      name: "administrator app01",
      username: "administrator",
      secret: "S3cret-windows-pass",
      hostIds: [windowsHost.body.id],
    });

    script = [
      [
        execCall({
          target: "app01",
          // The wrapper would expand $_ before PowerShell ever sees the filter.
          command:
            "powershell -Command \"Get-Service | Where-Object { $_.DisplayName -like '*Backup*' }\"",
          reason: "Look for the Backup services",
        }),
      ],
      [
        execCall(
          {
            target: "app01",
            command: "Get-Service | Where-Object { $_.DisplayName -like '*Backup*' }",
            reason: "Look for the Backup services",
          },
          "exec-2",
        ),
      ],
      [{ type: "text", text: "Here are the services." }],
    ];
    const { res } = await startChat(colleague.id, "Which Backup services run on app01?");
    // The turn only runs while its stream is being read.
    await res.text();

    const refusal = requests[1]?.messages.at(-1);
    expect(refusal).toMatchObject({ role: "tool", results: [{ isError: true }] });
    const content = refusal?.role === "tool" ? refusal.results[0]?.content : "";
    expect(content).toContain("already runs PowerShell");
    // Nothing was queued or sent to the runner for the wrapped command.
    expect(runs.map((run) => run.command)).toEqual([
      "Get-Service | Where-Object { $_.DisplayName -like '*Backup*' }",
    ]);
    const jobs = await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`);
    expect(jobs.body).toHaveLength(1);
  });

  it("waits for approval of changes and lets the person who asked decide", async () => {
    const { office, colleague } = await setup();
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    script = [
      [
        execCall({
          target: "app03",
          command: "systemctl restart nginx",
          reason: "nginx does not answer",
        }),
      ],
      [{ type: "text", text: "Restarted." }],
    ];
    const [admin] = await deps.db.select().from(users).where(eq(users.role, "admin"));
    const heard: unknown[] = [];
    const stopListening = liveEvents.subscribe(admin?.id ?? "", (event) => heard.push(event));
    const { conversationId, res } = await startChat(colleague.id, "Restart nginx please");
    const body = res.text();
    const listed = async () =>
      (await call<ConversationListItem[]>(`/conversations?colleagueId=${colleague.id}`)).body;

    let pending: OpsJob | undefined;
    for (let attempt = 0; attempt < 50 && !pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pending = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body.find(
        (job) => job.status === "pending_approval",
      );
    }
    expect(pending?.classification).toMatchObject({
      decision: "ask",
      types: ["systemctl restart"],
      onceOnly: false,
    });
    expect(runs).toHaveLength(0);
    // The person's open pages hear it at once, while the colleague still waits for the decision:
    // the conversation created, the answer starting, then the request waiting.
    const changed = { type: "conversation", colleagueId: colleague.id, conversationId };
    expect(heard).toEqual([changed, changed, changed]);
    stopListening();
    // The list of conversations says which ones wait, for the menu and the tabs.
    expect(await listed()).toEqual([
      expect.objectContaining({ id: conversationId, waiting: true }),
    ]);

    const refused = await call<ApiError>(
      `/offices/${office.id}/ops/jobs/${pending?.id}/decision`,
      "POST",
      { choice: "once" },
      member.cookie,
    );
    expect(refused.res.status).toBe(403);
    const approved = await call<OpsJob>(
      `/offices/${office.id}/ops/jobs/${pending?.id}/decision`,
      "POST",
      { choice: "always" },
    );
    expect(approved.res.status).toBe(200);

    parseSse(await body);
    expect(runs[0]?.command).toBe("systemctl restart nginx");
    const job = await call<OpsJob>(`/offices/${office.id}/ops/jobs/${pending?.id}`);
    expect(job.body).toMatchObject({ status: "done", decidedBy: "Administrator" });
    expect(await listed()).toEqual([
      expect.objectContaining({ id: conversationId, waiting: false }),
    ]);

    // "Allow always" approves the type of the command for the person it ran for.
    const mine = await call<ApprovedCommandType[]>("/me/command-types");
    expect(mine.body).toEqual([
      expect.objectContaining({ shell: "posix", type: "systemctl restart", disabledBy: null }),
    ]);
  });

  it("spares the person who approved a type on every host, the runner and all their colleagues", async () => {
    const { office, colleague, credential, host } = await setup();
    const other = await call<OpsHost>("/admin/hosts", "POST", {
      name: "srv10",
      kind: "linux",
      address: "10.0.0.31",
    });
    await call(`/me/credentials/${credential.id}`, "PATCH", {
      hostIds: [host.id, other.body.id],
    });
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const admin = (await call<{ id: string }>("/me")).body;
    const policy = { mode: "ask" as const };
    const rows = await deps.db.select().from(hosts);
    const target = (name: string): JobTarget => {
      const row = rows.find((item) => item.name === name);
      if (!row) throw new Error(`no host ${name}`);
      return { kind: "host", host: row };
    };
    const second = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.id,
        name: "Helpdesk",
        profileId: colleague.profileId,
      })
    ).body;
    const ask = (
      userId: string,
      on: JobTarget,
      command = "systemctl restart nginx",
      colleagueId = colleague.id,
    ) =>
      requestJob(deps.db, {
        officeId: office.id,
        colleagueId,
        conversationId: null,
        userId,
        target: on,
        command,
        reason: "test",
        timeoutSeconds: 10,
        policy,
      });

    // Only the piece that is not a read asks.
    const first = await ask(
      admin.id,
      target("app03"),
      "systemctl restart nginx && systemctl status nginx",
    );
    expect(first.status).toBe("pending_approval");
    expect(first.classification).toMatchObject({ types: ["systemctl restart"], onceOnly: false });
    await call(`/offices/${office.id}/ops/jobs/${first.id}/decision`, "POST", { choice: "always" });

    // From now on it does not ask again, on any host, on the runner, with any of their colleagues.
    expect((await ask(admin.id, target("app03"))).status).toBe("queued");
    expect((await ask(admin.id, target("srv10"))).status).toBe("queued");
    expect((await ask(admin.id, { kind: "runner" })).status).toBe("queued");
    expect((await ask(admin.id, target("srv10"), "systemctl restart apache2")).status).toBe(
      "queued",
    );
    const withSecond = await ask(admin.id, target("app03"), undefined, second.id);
    expect(withSecond.status).toBe("queued");
    // Another type still asks, and so does anyone else.
    expect((await ask(admin.id, target("app03"), "systemctl stop nginx")).status).toBe(
      "pending_approval",
    );
    expect((await ask(member.id, target("app03"))).status).toBe("pending_approval");

    // A person sees only their own types and cannot change someone else's.
    const [type] = (await call<ApprovedCommandType[]>("/me/command-types")).body;
    expect(type).toMatchObject({ type: "systemctl restart", userId: admin.id });
    expect(
      (await call<unknown[]>("/me/command-types", "GET", undefined, member.cookie)).body,
    ).toEqual([]);
    const refused = await call(`/me/command-types/${type?.id}`, "DELETE", undefined, member.cookie);
    expect(refused.res.status).toBe(404);
    const notTheirs = await call(
      `/me/command-types/${type?.id}`,
      "PATCH",
      { disabled: true },
      member.cookie,
    );
    expect(notTheirs.res.status).toBe(404);
  });

  it("approves once only a command that cannot be read to the end", async () => {
    const { office, colleague } = await setup();
    const admin = (await call<{ id: string }>("/me")).body;
    const job = await requestJob(deps.db, {
      officeId: office.id,
      colleagueId: colleague.id,
      conversationId: null,
      userId: admin.id,
      target: { kind: "runner" },
      command: "systemctl restart $(cat units.txt)",
      reason: "test",
      timeoutSeconds: 10,
      policy: { mode: "ask" },
    });
    expect(job.classification).toMatchObject({ decision: "ask", onceOnly: true });
    const decided = await call(`/offices/${office.id}/ops/jobs/${job.id}/decision`, "POST", {
      choice: "always",
    });
    expect(decided.res.status).toBe(200);
    expect((await call<unknown[]>("/me/command-types")).body).toEqual([]);
  });

  it("shows and lets decide a command only to the person it was asked for", async () => {
    const { office, colleague } = await setup();
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const theirs = (
      await createColleague(app, deps.db, member.cookie, {
        officeId: office.id,
        name: "Sysadmin",
        profileId: colleague.profileId,
      })
    ).body;
    const job = await requestJob(deps.db, {
      officeId: office.id,
      colleagueId: theirs.id,
      conversationId: null,
      userId: member.id,
      target: { kind: "runner" },
      command: "systemctl restart nginx",
      reason: "test",
      timeoutSeconds: 10,
      policy: { mode: "ask" },
    });
    expect(job.status).toBe("pending_approval");

    // Administrators included: the request lives in a conversation only its owner can open.
    expect((await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body).toEqual([]);
    expect((await call(`/offices/${office.id}/ops/jobs/${job.id}`)).res.status).toBe(404);
    const refused = await call(`/offices/${office.id}/ops/jobs/${job.id}/decision`, "POST", {
      choice: "once",
    });
    expect(refused.res.status).toBe(403);
    expect((await call(`/offices/${office.id}/ops/jobs/${job.id}/stop`, "POST")).res.status).toBe(
      403,
    );

    const own = await call<OpsJob[]>(
      `/offices/${office.id}/ops/jobs`,
      "GET",
      undefined,
      member.cookie,
    );
    expect(own.body.map((item) => item.id)).toEqual([job.id]);
    const decided = await call(
      `/offices/${office.id}/ops/jobs/${job.id}/decision`,
      "POST",
      { choice: "deny" },
      member.cookie,
    );
    expect(decided.res.status).toBe(200);
  });

  it("lets a person turn off and take back their own types", async () => {
    const { office, colleague } = await setup();
    const policy = { mode: "ask" as const };
    const admin = (await call<{ id: string }>("/me")).body;
    const job = await requestJob(deps.db, {
      officeId: office.id,
      colleagueId: colleague.id,
      conversationId: null,
      userId: admin.id,
      target: { kind: "runner" },
      command: "systemctl restart nginx",
      reason: "test",
      timeoutSeconds: 10,
      policy,
    });
    await call(`/offices/${office.id}/ops/jobs/${job.id}/decision`, "POST", { choice: "always" });
    const again = () =>
      requestJob(deps.db, {
        officeId: office.id,
        colleagueId: colleague.id,
        conversationId: null,
        userId: admin.id,
        target: { kind: "runner" },
        command: "systemctl restart nginx",
        reason: "test",
        timeoutSeconds: 10,
        policy,
      });
    const [type] = (await call<ApprovedCommandType[]>("/me/command-types")).body;

    const off = await call<ApprovedCommandType>(`/me/command-types/${type?.id}`, "PATCH", {
      disabled: true,
    });
    expect(off.body).toMatchObject({ disabledBy: "owner" });
    expect((await again()).status).toBe("pending_approval");
    await call(`/me/command-types/${type?.id}`, "PATCH", { disabled: false });
    expect((await again()).status).toBe("queued");

    const removed = await call(`/me/command-types/${type?.id}`, "DELETE");
    expect(removed.res.status).toBe(204);
    expect((await call<unknown[]>("/me/command-types")).body).toEqual([]);
    expect((await again()).status).toBe("pending_approval");
    const logged = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.target, "systemctl restart"));
    expect(logged.map((event) => [event.action, event.officeId])).toEqual([
      ["command_type.disable", null],
      ["command_type.enable", null],
      ["command_type.delete", null],
    ]);
  });

  it("lets an administrator see the types of a person and turn them off for good", async () => {
    const { office, colleague } = await setup();
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const theirs = (
      await createColleague(app, deps.db, member.cookie, {
        officeId: office.id,
        name: "Sysadmin",
        profileId: colleague.profileId,
      })
    ).body;
    const ask = () =>
      requestJob(deps.db, {
        officeId: office.id,
        colleagueId: theirs.id,
        conversationId: null,
        userId: member.id,
        target: { kind: "runner" },
        command: "docker system prune -f",
        reason: "test",
        timeoutSeconds: 10,
        policy: { mode: "ask" },
      });
    const first = await ask();
    await call(
      `/offices/${office.id}/ops/jobs/${first.id}/decision`,
      "POST",
      { choice: "always" },
      member.cookie,
    );
    expect((await ask()).status).toBe("queued");

    const listed = await call<ApprovedCommandType[]>(`/admin/people/${member.id}/command-types`);
    expect(listed.body).toEqual([expect.objectContaining({ type: "docker system prune" })]);
    const typeId = listed.body[0]?.id;
    expect(
      (await call(`/admin/people/${member.id}/command-types`, "GET", undefined, member.cookie)).res
        .status,
    ).toBe(403);
    const off = await call<ApprovedCommandType>(
      `/admin/people/${member.id}/command-types/${typeId}`,
      "PATCH",
      { disabled: true },
    );
    expect(off.body).toMatchObject({ disabledBy: "admin" });

    // Now it asks once each time, and the person can neither enable it nor remove it.
    const blocked = await ask();
    expect(blocked.classification).toMatchObject({ decision: "ask", onceOnly: true });
    await call(
      `/offices/${office.id}/ops/jobs/${blocked.id}/decision`,
      "POST",
      { choice: "always" },
      member.cookie,
    );
    expect((await ask()).status).toBe("pending_approval");
    for (const [method, body] of [
      ["PATCH", { disabled: false }],
      ["DELETE", undefined],
    ] as const) {
      const refused = await call<ApiError>(
        `/me/command-types/${typeId}`,
        method,
        body,
        member.cookie,
      );
      expect(refused.res.status).toBe(409);
    }

    await call(`/admin/people/${member.id}/command-types/${typeId}`, "PATCH", { disabled: false });
    expect((await ask()).status).toBe("queued");
  });

  it("refuses destructive commands and continues after a late approval", async () => {
    const { office, colleague } = await setup();
    OPS_WAITS.approvalMs = 200;
    script = [
      [
        execCall({ target: "app03", command: "rm -rf /", reason: "cleanup" }, "a"),
        // A second step with a change that nobody approves in time.
      ],
      [execCall({ target: "app03", command: "systemctl restart nginx", reason: "fix" }, "b")],
      [{ type: "text", text: "I asked for approval." }],
    ];
    const { conversationId, res } = await startChat(colleague.id, "Clean up and fix nginx");
    parseSse(await res.text());

    const first = requests[1]?.messages.at(-1);
    expect(first?.role === "tool" ? first.results[0] : null).toMatchObject({ isError: true });
    const second = requests[2]?.messages.at(-1);
    expect(second?.role === "tool" ? second.results[0]?.content : "").toContain(
      "Waiting for approval",
    );
    expect(runs).toHaveLength(0);

    const jobs = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body;
    expect(jobs.map((job) => [job.command, job.status])).toEqual([
      ["systemctl restart nginx", "pending_approval"],
      ["rm -rf /", "denied"],
    ]);
    const pending = jobs[0];
    await call(`/offices/${office.id}/ops/jobs/${pending?.id}/decision`, "POST", {
      choice: "once",
    });

    // The worker runs it, then the colleague continues the conversation with the result.
    const claimed = await claimJob(deps.db, pending?.id ?? "");
    expect(claimed).not.toBeNull();
    if (claimed) {
      await executeJob(opsDeps, claimed);
    }
    script = [[{ type: "text", text: "nginx is back." }]];
    await continueAfterJob(opsDeps, pending?.id ?? "");

    const followUp = requests.at(-1)?.messages.at(-1);
    expect(followUp).toMatchObject({
      role: "user",
      content: expect.stringContaining("<ops_job_result>"),
    });
    expect((await findJobRow(deps.db, pending?.id ?? ""))?.reported).toBe(true);
    const stored = await call<Conversation>(`/conversations/${conversationId}`);
    expect(stored.body.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "nginx is back.",
    });
  });

  it("keeps one request waiting when the same command is asked for again", async () => {
    const { office, colleague } = await setup();
    OPS_WAITS.approvalMs = 200;
    script = [
      [execCall({ target: "app03", command: "systemctl restart nginx", reason: "fix" })],
      [{ type: "text", text: "I asked for approval." }],
    ];
    const { conversationId, res } = await startChat(colleague.id, "Fix nginx please");
    parseSse(await res.text());

    // Asked again because the person could not find the approval: the colleague is told the
    // request is still waiting, and asking for it again does not add a second one to decide.
    script = [
      [execCall({ target: "app03", command: "systemctl restart nginx", reason: "fix" }, "again")],
      [{ type: "text", text: "It is still waiting for you." }],
    ];
    const again = await app.request(
      `/api/conversations/${conversationId}/messages`,
      jsonRequest("POST", { content: "I cannot see that approval, ask me again" }, adminCookie),
    );
    parseSse(await again.text());

    const waiting = requests.flatMap((request) =>
      request.messages.flatMap((message) =>
        message.role !== "tool" &&
        typeof message.content === "string" &&
        message.content.includes("<ops_jobs_waiting>")
          ? [message.content]
          : [],
      ),
    );
    expect(waiting[0]).toContain("systemctl restart nginx");
    const jobs = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body;
    expect(jobs.filter((job) => job.status === "pending_approval")).toHaveLength(1);
  });

  it("shows a host only to people who stored a credential for it, and acts as them", async () => {
    const { office, colleague: adminsColleague, host } = await setup();
    const mario = await createMember(deps.db, "mario@example.com", [office.id]);
    const colleague = (
      await createColleague(app, deps.db, mario.cookie, {
        officeId: office.id,
        name: "Sysadmin",
        profileId: adminsColleague.profileId,
      })
    ).body;

    // Mario has no credential for app03 yet: the colleague cannot work there, and says how to
    // change that.
    script = [
      [execCall({ target: "app03", command: "whoami", reason: "Check the account" })],
      [{ type: "text", text: "I cannot reach that server for you." }],
    ];
    const first = await startChat(colleague.id, "Who am I on app03?", mario.cookie);
    parseSse(await first.res.text());
    expect(runs).toHaveLength(0);
    const unknown = requests[1]?.messages.at(-1);
    expect(unknown?.role === "tool" ? unknown.results[0]?.content : "").toContain(
      "no credential on app03 yet",
    );

    // With a credential of their own, Mario's colleague works there as mario, not as the
    // administrator.
    await storeCredential(mario.cookie, {
      name: "mario",
      username: "mario",
      secret: "S3cret-mario-pass",
      hostIds: [host.id],
    });
    script = [
      [execCall({ target: "app03", command: "whoami", reason: "Check the account" })],
      [{ type: "text", text: "You are mario." }],
    ];
    const second = await startChat(colleague.id, "Who am I on app03?", mario.cookie);
    parseSse(await second.res.text());
    expect(runs[0]?.target).toMatchObject({
      username: "mario",
      auth: { type: "password", password: "S3cret-mario-pass" },
    });
    expect(runs[0]?.secrets).toEqual(["S3cret-mario-pass"]);
    const used = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "credential.use"));
    expect(used).toEqual([
      expect.objectContaining({
        officeId: office.id,
        actorColleagueId: colleague.id,
        detail: expect.objectContaining({ credential: "mario", username: "mario" }),
      }),
    ]);
  });

  it("reads the credential when the command runs, not when it was asked for", async () => {
    const { office, colleague, credential } = await setup();
    OPS_WAITS.approvalMs = 200;
    script = [
      [execCall({ target: "app03", command: "systemctl restart nginx", reason: "fix" })],
      [{ type: "text", text: "I asked for approval." }],
    ];
    const { res } = await startChat(colleague.id, "Restart nginx please");
    parseSse(await res.text());
    const [pending] = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body;
    expect(pending?.status).toBe("pending_approval");

    // The credential is removed while the request waits: approving it runs nothing.
    await call(`/me/credentials/${credential.id}`, "DELETE");
    await call(`/offices/${office.id}/ops/jobs/${pending?.id}/decision`, "POST", {
      choice: "once",
    });
    const claimed = await claimJob(deps.db, pending?.id ?? "");
    if (claimed) {
      await executeJob(opsDeps, claimed);
    }
    expect(runs).toHaveLength(0);
    expect((await findJobRow(deps.db, pending?.id ?? ""))?.error).toBe("host_not_allowed");
  });

  it("keeps one credential per person on a host", async () => {
    const { office, credential, host } = await setup();
    const second = await storeCredential(adminCookie, {
      name: "helpdesk app03",
      username: "helpdesk",
      secret: "S3cret-helpdesk-pass",
      hostIds: [host.id],
    });
    expect(second.res.status).toBe(409);
    expect((second.body as unknown as ApiError).issues).toEqual([
      { path: "hostIds", code: "host_has_credential" },
    ]);

    const spare = await storeCredential(adminCookie, {
      name: "helpdesk app03",
      username: "helpdesk",
      secret: "S3cret-helpdesk-pass",
      hostIds: [],
    });
    expect(spare.res.status).toBe(201);
    const moved = await call<ApiError>(`/me/credentials/${spare.body.id}`, "PATCH", {
      hostIds: [host.id],
    });
    expect(moved.res.status).toBe(409);
    // Moving it means taking it off the other credential first.
    await call(`/me/credentials/${credential.id}`, "PATCH", { hostIds: [] });
    const retried = await call<Credential>(`/me/credentials/${spare.body.id}`, "PATCH", {
      hostIds: [host.id],
    });
    expect(retried.body.hostIds).toEqual([host.id]);

    // Someone else may use the same host with their own account.
    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const theirs = await storeCredential(member.cookie, {
      name: "helpdesk app03",
      username: "member",
      secret: "S3cret-member-pass",
      hostIds: [host.id],
    });
    expect(theirs.res.status).toBe(201);
  });

  it("gives no command tools when the profile denies them, and says so", async () => {
    const { colleague } = await setup();
    await useMode(colleague, "deny");
    const { res } = await startChat(colleague.id, "Ping app03");
    parseSse(await res.text());
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("ops_exec");
    expect(requests[0]?.system).toContain("Your profile does not let you run commands");
    expect(requests[0]?.system).not.toContain("ops_exec");
  });

  it("tells the person to add a credential for the hosts they have none on", async () => {
    const { colleague, credential } = await setup();
    await call<OpsHost>("/admin/hosts", "POST", {
      name: "web01",
      kind: "windows",
      address: "10.0.0.1",
    });
    script = [
      [{ type: "tool_calls", calls: [{ id: "t", name: "ops_targets", input: {} }] }],
      [execCall({ target: "WEB01", command: "hostname", reason: "Check the name" })],
      [{ type: "text", text: "You need a credential there." }],
    ];
    const { res } = await startChat(colleague.id, "Check web01");
    parseSse(await res.text());
    const toolResult = (request: ChatRequest | undefined) => {
      const message = request?.messages.at(-1);
      return message?.role === "tool" ? (message.results[0]?.content ?? "") : "";
    };
    expect(toolResult(requests[1])).toContain("no credential yet on: web01.");
    expect(toolResult(requests[1])).toContain("- app03:");
    expect(toolResult(requests[2])).toContain(
      "no credential on web01 yet: tell them to add their own for it in Account → Credentials",
    );
    expect(runs).toHaveLength(0);

    // Without credentials and without a runner there are no command tools: the instructions say
    // why, so the colleague does not just answer that it cannot.
    await call(`/me/credentials/${credential.id}`, "PATCH", { hostIds: [] });
    const withoutRunner = createApp({ ...deps, llm: fakeLlm, runner: null });
    requests.length = 0;
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    const answer = await withoutRunner.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "Check app03" }, adminCookie),
    );
    parseSse(await answer.text());
    expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain("ops_exec");
    expect(requests[0]?.system).toContain("they have none yet on these: app03, web01.");
    expect(requests[0]?.system).toContain("Account → Credentials, never in the chat");
    expect(requests[0]?.system).toContain("Never mention the runner to the person");

    // The page is named as the person's own screens name it.
    await call("/me/preferences", "PATCH", { locale: "it" });
    requests.length = 0;
    const again = await withoutRunner.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "Controlla app03" }, adminCookie),
    );
    parseSse(await again.text());
    expect(requests[0]?.system).toContain("Account → Credenziali, never in the chat");
    expect(requests[0]?.system).not.toContain("Account → Credentials");
  });

  it("runs commands without asking in full access, but still refuses blocked ones", async () => {
    const { colleague } = await setup();
    await useMode(colleague, "full");
    script = [
      [execCall({ target: "app03", command: "systemctl restart nginx", reason: "Restart" }, "a")],
      [execCall({ target: "app03", command: "rm -rf /", reason: "Clean up" }, "b")],
      [{ type: "text", text: "Done." }],
    ];
    const { res } = await startChat(colleague.id, "Restart nginx on app03");
    parseSse(await res.text());
    expect(runs.map((run) => run.command)).toEqual(["systemctl restart nginx"]);
    // The colleague is not told that its commands wait for approval.
    expect(requests[0]?.system).toContain("Commands run without approval, but destructive ones");
    expect(requests[0]?.system).not.toContain("wait for a person's approval");
    const exec = requests[0]?.tools?.find((tool) => tool.name === "ops_exec");
    expect(exec?.description).toContain("Command policy: commands run without approval");
  });

  it("lets blocked commands through in yolo mode", async () => {
    const { colleague } = await setup();
    await useMode(colleague, "yolo");
    script = [
      [execCall({ target: "app03", command: "wipefs -a /dev/sdb", reason: "Reuse the disk" })],
      [{ type: "text", text: "Done." }],
    ];
    const { res } = await startChat(colleague.id, "Wipe the spare disk on app03");
    parseSse(await res.text());
    expect(runs.map((run) => run.command)).toEqual(["wipefs -a /dev/sdb"]);
  });
});
