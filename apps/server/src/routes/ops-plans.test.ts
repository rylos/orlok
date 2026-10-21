import type {
  ApprovedCommandType,
  ConversationSummary,
  Credential,
  ModelProvider,
  OpsHost,
  OpsJob,
  RunnerJobRequest,
  RunnerJobState,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { colleagues, opsJobs, opsPlans, profileGrants, users } from "../db/schema";
import type { ChatChunk, ChatRequest, LlmClientFactory } from "../llm";
import { formatJobResult, staleApproval, startOpsWorker } from "../ops/jobs";
import type { RunnerClient } from "../ops/runner-client";
import { OPS_WAITS } from "../ops/tools";
import { liveEvents } from "../services/live-events";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

// Plans (R-OPS-6).

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

const runs: RunnerJobRequest[] = [];
// Commands that end with a non-zero exit code.
const failing = new Set<string>();
function state(id: string): RunnerJobState {
  const request = runs.find((item) => item.id === id);
  const command = request?.command ?? "";
  return {
    id,
    status: "done",
    exitCode: failing.has(command) ? 1 : 0,
    output: `ran: ${command}`,
    truncated: false,
    hostKey: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
const fakeRunner: RunnerClient = {
  async health() {
    return { ok: true, version: "test", tools: [] };
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
  async wait(id) {
    return state(id);
  },
};

const opsDeps = { ...deps, llm: fakeLlm, runner: fakeRunner };
const app = createApp(opsDeps);
let stopWorker: (() => void) | null = null;

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  runs.length = 0;
  failing.clear();
  script = [];
  OPS_WAITS.approvalMs = 15_000;
  OPS_WAITS.runMs = 10_000;
  adminCookie = await setupAdmin(app);
});

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
  for (const stop of stopListening.splice(0)) {
    stop();
  }
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

function toolCall(name: string, input: Record<string, unknown>, id = name): ChatChunk {
  return { type: "tool_calls", calls: [{ id, name, input }] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const office = (await call<{ id: string }>("/admin/offices", "POST", { name: "IT" })).body;
  const colleague = (
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Sysadmin",
    })
  ).body;
  const host = await call<OpsHost>("/admin/hosts", "POST", {
    name: "web01",
    kind: "linux",
    address: "10.0.0.40",
  });
  await call<Credential>("/me/credentials", "POST", {
    name: "root web01",
    kind: "password",
    username: "root",
    secret: "S3cret-root-pass",
    hostIds: [host.body.id],
  });
  return { office, colleague };
}

async function sendMessage(colleagueId: string, content: string) {
  const conversation = await call<ConversationSummary>("/conversations", "POST", {
    colleagueId,
  });
  const res = await app.request(
    `/api/conversations/${conversation.body.id}/messages`,
    jsonRequest("POST", { content }, adminCookie),
  );
  return res.text();
}

// Starts hearing what the administrator's open pages hear, from now on.
const stopListening: (() => void)[] = [];
async function listen() {
  const [admin] = await deps.db.select().from(users).where(eq(users.role, "admin"));
  const heard: unknown[] = [];
  stopListening.push(liveEvents.subscribe(admin?.id ?? "", (event) => heard.push(event)));
  return heard;
}

async function waitForJobs(officeId: string, ready: (jobs: OpsJob[]) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const jobs = (await call<OpsJob[]>(`/offices/${officeId}/ops/jobs`)).body;
    if (ready(jobs)) {
      return jobs;
    }
    await sleep(100);
  }
  throw new Error("Jobs not ready in time");
}

describe("plans", () => {
  const plan = (steps: { command: string; reason: string }[]) =>
    toolCall("ops_plan", {
      title: "Restart the web server",
      summary: "Stop nginx, then check the uptime. Rollback: start nginx.",
      steps: steps.map((step) => ({ target: "web01", ...step })),
    });

  it("runs the steps in order once the whole plan is approved", async () => {
    const { office, colleague } = await setup();
    stopWorker = startOpsWorker(opsDeps, () => {}, 200);
    script = [
      [
        plan([
          { command: "systemctl stop nginx", reason: "stop it" },
          { command: "uptime", reason: "check the server" },
        ]),
      ],
      [{ type: "text", text: "Done" }],
    ];
    const body = sendMessage(colleague.id, "Restart the web server");

    const jobs = await waitForJobs(office.id, (list) => list.length === 2);
    const steps = [...jobs].sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0));
    expect(steps.map((job) => job.status)).toEqual(["pending_approval", "queued"]);
    expect(steps[0]?.plan).toMatchObject({
      title: "Restart the web server",
      status: "pending_approval",
      step: 1,
      stepCount: 2,
    });
    // The allowed second step must not start before the first one.
    await sleep(3_500);
    expect(runs).toHaveLength(0);

    const planId = steps[0]?.plan?.id;
    const decision = await call<{ status: string }>(
      `/offices/${office.id}/ops/plans/${planId}/decision`,
      "POST",
      { choice: "approve" },
    );
    expect(decision.res.status).toBe(200);
    parseSse(await body);

    expect(runs.map((run) => run.command)).toEqual(["systemctl stop nginx", "uptime"]);
    const result = requests[1]?.messages.at(-1);
    const text = result?.role === "tool" ? (result.results[0]?.content ?? "") : "";
    expect(text).toContain('"Restart the web server": done');
    expect(text).toContain("ran: uptime");
  }, 30_000);

  it("remembers the types of the readable steps with approve and always allow", async () => {
    const { office, colleague } = await setup();
    stopWorker = startOpsWorker(opsDeps, () => {}, 200);
    OPS_WAITS.approvalMs = 200;
    script = [
      [
        plan([
          { command: "systemctl stop nginx", reason: "stop it" },
          { command: "echo $(date)", reason: "note the time" },
        ]),
      ],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Restart the web server"));
    const pending = await waitForJobs(office.id, (list) => list.length === 2);
    const planId = pending[0]?.plan?.id;

    // Only the person it was asked for decides.
    const other = await createMember(deps.db, "other@example.com", [office.id]);
    const refused = await call(
      `/offices/${office.id}/ops/plans/${planId}/decision`,
      "POST",
      { choice: "approve_always" },
      other.cookie,
    );
    expect(refused.res.status).toBe(403);
    expect((await call<ApprovedCommandType[]>("/me/command-types")).body).toEqual([]);

    const decision = await call(`/offices/${office.id}/ops/plans/${planId}/decision`, "POST", {
      choice: "approve_always",
    });
    expect(decision.res.status).toBe(200);
    await waitForJobs(office.id, (list) => list.every((job) => job.status === "done"));
    expect(runs.map((run) => run.command)).toEqual(["systemctl stop nginx", "echo $(date)"]);
    // The step with a substitution ran this time only: nothing of it is remembered.
    const types = (await call<ApprovedCommandType[]>("/me/command-types")).body;
    expect(types.map((type) => type.type)).toEqual(["systemctl stop"]);

    // The next plan made only of approved types and reads does not ask.
    script = [
      [
        plan([
          { command: "systemctl stop nginx", reason: "stop it" },
          { command: "uptime", reason: "check" },
        ]),
      ],
      [{ type: "text", text: "Done" }],
    ];
    parseSse(await sendMessage(colleague.id, "Stop it again"));
    const jobs = await waitForJobs(
      office.id,
      (list) => list.length === 4 && list.every((job) => job.status === "done"),
    );
    expect(jobs.every((job) => job.status === "done")).toBe(true);
  }, 30_000);

  it("stops the remaining steps when one fails", async () => {
    const { office, colleague } = await setup();
    stopWorker = startOpsWorker(opsDeps, () => {}, 200);
    failing.add("systemctl stop nginx");
    OPS_WAITS.approvalMs = 200;
    script = [
      [
        plan([
          { command: "systemctl stop nginx", reason: "stop it" },
          { command: "systemctl start nginx", reason: "start it" },
        ]),
      ],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Restart the web server"));
    const pending = await waitForJobs(office.id, (list) => list.length === 2);
    const planId = pending[0]?.plan?.id;
    await call(`/offices/${office.id}/ops/plans/${planId}/decision`, "POST", {
      choice: "approve",
    });

    const jobs = await waitForJobs(office.id, (list) =>
      list.every((job) => job.status !== "queued" && job.status !== "running"),
    );
    const steps = [...jobs].sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0));
    expect(steps.map((job) => [job.status, job.exitCode, job.error])).toEqual([
      ["done", 1, null],
      ["stopped", null, "previous_step_failed"],
    ]);
    expect(steps[1]?.plan?.status).toBe("failed");
    expect(runs.map((run) => run.command)).toEqual(["systemctl stop nginx"]);
  }, 30_000);

  // A restart while a step runs: the runner is another container, so the step may have run. It
  // is never run again by itself, the plan stops instead of staying "running" forever, and the
  // person and the colleague are told its outcome is unknown.
  it("stops a plan whose step was interrupted by a restart, and reports it", async () => {
    const { office, colleague } = await setup();
    OPS_WAITS.approvalMs = 200;
    script = [
      [
        plan([
          { command: "systemctl stop nginx", reason: "stop it" },
          { command: "systemctl start nginx", reason: "start it" },
        ]),
      ],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Restart the web server"));
    const pending = await waitForJobs(office.id, (list) => list.length === 2);
    const first = pending.find((job) => job.plan?.step === 1);
    const planId = first?.plan?.id ?? "";
    // What a server stopped mid-step leaves behind.
    await deps.db.update(opsPlans).set({ status: "running" }).where(eq(opsPlans.id, planId));
    await deps.db
      .update(opsJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(opsJobs.id, first?.id ?? ""));

    const reported: string[] = [];
    stopWorker = startOpsWorker(opsDeps, (job) => reported.push(job.id), 200);
    const jobs = await waitForJobs(office.id, (list) =>
      list.every(
        (job) =>
          job.status !== "running" && job.status !== "queued" && job.status !== "pending_approval",
      ),
    );
    const steps = [...jobs].sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0));
    expect(steps.map((job) => [job.status, job.error])).toEqual([
      ["failed", "interrupted"],
      ["stopped", "previous_step_failed"],
    ]);
    expect(steps[0]?.plan?.status).toBe("failed");
    expect(reported).toEqual([first?.id]);
    expect(runs).toHaveLength(0);
    const [row] = await deps.db
      .select()
      .from(opsJobs)
      .where(eq(opsJobs.id, first?.id ?? ""));
    expect(row && formatJobResult(row)).toContain("its outcome is unknown");
  }, 30_000);

  it("refuses the whole plan when a step is forbidden", async () => {
    const { office, colleague } = await setup();
    stopWorker = startOpsWorker(opsDeps, () => {}, 200);
    script = [
      [
        plan([
          { command: "uptime", reason: "check" },
          { command: "rm -rf /", reason: "clean up" },
        ]),
      ],
      [{ type: "text", text: "Refused" }],
    ];
    parseSse(await sendMessage(colleague.id, "Clean the server"));
    const result = requests[1]?.messages.at(-1);
    const text = result?.role === "tool" ? (result.results[0]?.content ?? "") : "";
    expect(text).toContain("Plan refused");

    await sleep(3_500);
    const jobs = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body;
    const steps = [...jobs].sort((a, b) => (a.plan?.step ?? 0) - (b.plan?.step ?? 0));
    expect(steps.map((job) => job.status)).toEqual(["stopped", "denied"]);
    expect(steps[0]?.plan?.status).toBe("denied");
    expect(runs).toHaveLength(0);

    // A person can deny a waiting plan too.
    OPS_WAITS.approvalMs = 200;
    script = [
      [plan([{ command: "systemctl stop nginx", reason: "stop it" }])],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Stop nginx"));
    const waiting = await waitForJobs(office.id, (list) =>
      list.some((job) => job.status === "pending_approval"),
    );
    const pendingStep = waiting.find((job) => job.status === "pending_approval");
    const planId = pendingStep?.plan?.id;
    const heard = await listen();
    const denied = await call<{ status: string }>(
      `/offices/${office.id}/ops/plans/${planId}/decision`,
      "POST",
      { choice: "deny" },
    );
    expect(denied.body.status).toBe("denied");
    // The person's other pages hear that the plan no longer waits.
    expect(heard[0]).toEqual({
      type: "conversation",
      colleagueId: colleague.id,
      conversationId: pendingStep?.conversationId,
    });
    expect(
      (
        await call(`/offices/${office.id}/ops/plans/${planId}/decision`, "POST", {
          choice: "approve",
        })
      ).res.status,
    ).toBe(409);
  }, 30_000);
});

// An approval is given under the profile and the approvals of its moment, and a request can wait
// for days: what runs is judged again just before it runs, and a profile change cancels what
// still waits (R-OPS-4).
describe("approvals re-checked", () => {
  async function waitingCommand() {
    const { office, colleague } = await setup();
    OPS_WAITS.approvalMs = 200;
    script = [
      [
        toolCall("ops_exec", {
          target: "web01",
          command: "systemctl restart nginx",
          reason: "fix",
        }),
      ],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Restart nginx"));
    const [job] = await waitForJobs(office.id, (list) => list.length === 1);
    return { office, colleague, job };
  }

  // What the person's open pages hear: they do not ask every few seconds whether a request still
  // waits, so every way of ending the wait must tell them (R-CHAT-14).
  it("tells the person's pages when a request is decided or stopped", async () => {
    const { office, colleague, job } = await waitingCommand();
    const changed = (conversationId: string | null | undefined) => ({
      type: "conversation",
      colleagueId: colleague.id,
      conversationId,
    });
    let heard = await listen();
    const decided = await call(`/offices/${office.id}/ops/jobs/${job?.id}/decision`, "POST", {
      choice: "deny",
    });
    expect(decided.res.status).toBe(200);
    expect(heard[0]).toEqual(changed(job?.conversationId));

    script = [
      [
        toolCall("ops_exec", {
          target: "web01",
          command: "systemctl restart nginx",
          reason: "again",
        }),
      ],
      [{ type: "text", text: "Waiting" }],
    ];
    parseSse(await sendMessage(colleague.id, "Restart nginx again"));
    const [second] = (await waitForJobs(office.id, (list) => list.length === 2)).filter(
      (item) => item.status === "pending_approval",
    );
    heard = await listen();
    const stopped = await call(`/offices/${office.id}/ops/jobs/${second?.id}/stop`, "POST");
    expect(stopped.res.status).toBeLessThan(300);
    expect(heard[0]).toEqual(changed(second?.conversationId));
  }, 30_000);

  it("does not run an approved command once its colleague's profile no longer allows commands", async () => {
    const { colleague, job } = await waitingCommand();
    expect(job?.status).toBe("pending_approval");
    const [pending] = await deps.db
      .select()
      .from(opsJobs)
      .where(eq(opsJobs.id, job?.id ?? ""));
    // Approved by the person it was asked for.
    const row = pending && { ...pending, decidedByUserId: pending.requestedForUserId };
    expect(row && (await staleApproval(deps.db, row))).toBeNull();

    // A deny profile, granted and given to the colleague behind the server's back.
    const provider = (await call<ModelProvider[]>("/admin/providers")).body[0];
    const deny = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "No commands",
        providerId: provider?.id,
        model: "model",
        mode: "deny",
      })
    ).body;
    const [admin] = await deps.db.select().from(users);
    await deps.db.insert(profileGrants).values({ userId: admin?.id ?? "", profileId: deny.id });
    await deps.db
      .update(colleagues)
      .set({ profileId: deny.id })
      .where(eq(colleagues.id, colleague.id));
    expect(row && (await staleApproval(deps.db, row))).toContain("no longer allows commands");
  }, 30_000);

  it("refuses at run time a command allowed without approval that now needs one", async () => {
    const { job } = await waitingCommand();
    const [row] = await deps.db
      .select()
      .from(opsJobs)
      .where(eq(opsJobs.id, job?.id ?? ""));
    // As if it had been queued without asking (full mode then), and nobody decided it.
    const queued = row && { ...row, status: "queued" as const, decidedByUserId: null };
    expect(queued && (await staleApproval(deps.db, queued))).toBe(
      "the command now needs an approval nobody gave",
    );
    // Approved by its person, it runs whatever its types are now.
    const approved = row && { ...row, decidedByUserId: row.requestedForUserId };
    expect(approved && (await staleApproval(deps.db, approved))).toBeNull();
  }, 30_000);

  it("cancels what waits when the colleague changes profile", async () => {
    const { colleague, job } = await waitingCommand();
    const provider = (await call<ModelProvider[]>("/admin/providers")).body[0];
    const other = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "Full",
        providerId: provider?.id,
        model: "model",
        mode: "full",
      })
    ).body;
    const [admin] = await deps.db.select().from(users);
    await deps.db.insert(profileGrants).values({ userId: admin?.id ?? "", profileId: other.id });
    const heard = await listen();
    const changed = await call(`/colleagues/${colleague.id}`, "PATCH", { profileId: other.id });
    expect(changed.res.status).toBe(200);
    expect(heard).toContainEqual({
      type: "conversation",
      colleagueId: colleague.id,
      conversationId: job?.conversationId,
    });
    const [row] = await deps.db
      .select()
      .from(opsJobs)
      .where(eq(opsJobs.id, job?.id ?? ""));
    expect(row).toMatchObject({ status: "stopped", error: "profile_changed" });
  }, 30_000);
});
