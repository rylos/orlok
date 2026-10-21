import type {
  ConversationSummary,
  Credential,
  ModelProvider,
  NotificationSettings,
  OpsHost,
  OpsJob,
  RunnerJobRequest,
  RunnerJobState,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { officeMembers } from "../db/schema";
import type { ChatChunk, LlmClientFactory } from "../llm";
import type { MailerFactory, MailMessage } from "../mail";
import { startOpsWorker } from "../ops/jobs";
import type { RunnerClient } from "../ops/runner-client";
import { OPS_WAITS } from "../ops/tools";
import { notifyInterventionFinished } from "../services/notifications";
import type { PushSender } from "../services/push";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

// Notifications about approvals and finished interventions (R-CHAT-7).

const deps = createTestDeps();
let script: ChatChunk[][] = [];
const sent: MailMessage[] = [];
const pushed: { endpoint: string; payload: { title: string; body: string; url: string } }[] = [];
const runs: RunnerJobRequest[] = [];

const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat() {
    for (const chunk of script.shift() ?? [{ type: "text", text: "OK" }]) {
      yield chunk;
    }
    yield { type: "done", stopReason: "end_turn", usage: null };
  },
});

const fakeMail: MailerFactory = () => ({
  async send(message) {
    sent.push(message);
  },
});

const fakePush: PushSender = async (target, payload) => {
  if (target.endpoint.includes("gone")) {
    throw Object.assign(new Error("Subscription expired"), { statusCode: 410 });
  }
  pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
};

function state(id: string): RunnerJobState {
  return {
    id,
    status: "done",
    exitCode: 0,
    output: "ok",
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

const appDeps = { ...deps, llm: fakeLlm, runner: fakeRunner, mail: fakeMail, push: fakePush };
const app = createApp(appDeps);
let stopWorker: (() => void) | null = null;

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  script = [];
  sent.length = 0;
  pushed.length = 0;
  runs.length = 0;
  OPS_WAITS.approvalMs = 200;
  adminCookie = await setupAdmin(app);
});

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function eventually<T>(read: () => T | undefined) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Condition not met in time");
}

describe("notifications", () => {
  it("tells approvers about approvals and the requester when the intervention ends", async () => {
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
    await call("/admin/smtp", "PUT", {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: null,
      password: null,
      fromAddress: "orlok@example.com",
      fromName: "Orlok",
    });
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
      name: "root",
      kind: "password",
      username: "root",
      secret: "S3cret-root-pass",
      hostIds: [host.body.id],
    });

    // A manager and a plain member of the same office, both with email on: neither takes part in
    // the conversation, so neither hears about its approval.
    const manager = await createMember(deps.db, "manager@example.com", [office.id]);
    await deps.db
      .update(officeMembers)
      .set({ role: "manager" })
      .where(eq(officeMembers.userId, manager.id));
    await createMember(deps.db, "member@example.com", [office.id]);
    const managerSettings = await call<NotificationSettings>(
      "/me/notifications",
      "GET",
      undefined,
      manager.cookie,
    );
    expect(managerSettings.body).toMatchObject({ email: true, push: true, devices: 0 });

    // The administrator enables push on two browsers, one of which has expired.
    const settings = await call<NotificationSettings>("/me/notifications");
    expect(settings.body.vapidPublicKey.length).toBeGreaterThan(40);
    for (const endpoint of ["https://push.example/admin", "https://push.example/gone"]) {
      const subscribed = await call("/me/push-subscriptions", "POST", {
        endpoint,
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      });
      expect(subscribed.res.status).toBe(204);
    }
    expect((await call<NotificationSettings>("/me/notifications")).body.devices).toBe(2);

    script = [
      [
        {
          type: "tool_calls",
          calls: [
            {
              id: "exec",
              name: "ops_exec",
              input: {
                target: "web01",
                command: "systemctl restart nginx",
                reason: "nginx is down",
              },
            },
          ],
        },
      ],
      [{ type: "text", text: "Waiting for approval" }],
    ];
    const conversation = await call<ConversationSummary>("/conversations", "POST", {
      colleagueId: colleague.id,
    });
    const res = await app.request(
      `/api/conversations/${conversation.body.id}/messages`,
      jsonRequest("POST", { content: "The site is down" }, adminCookie),
    );
    parseSse(await res.text());

    const approvalEmail = await eventually(() => sent.find((m) => m.to === "admin@example.com"));
    expect(approvalEmail.subject).toBe("Sysadmin asks for approval");
    expect(approvalEmail.text).toContain("systemctl restart nginx");
    expect(approvalEmail.text).toContain(
      `http://orlok.test/colleagues/${colleague.id}/${conversation.body.id}`,
    );
    const push = await eventually(() => pushed[0]);
    expect(push).toMatchObject({
      endpoint: "https://push.example/admin",
      payload: { url: `/colleagues/${colleague.id}/${conversation.body.id}` },
    });
    await eventually(() => (sent.length === 1 ? true : undefined));
    // Only the person whose conversation it is, never the other people of the office.
    expect(sent.map((message) => message.to)).toEqual(["admin@example.com"]);
    // The expired subscription was removed.
    expect((await call<NotificationSettings>("/me/notifications")).body.devices).toBe(1);

    // Approved later: the background worker runs it and tells the person who asked.
    stopWorker = startOpsWorker(
      appDeps,
      (job) => void notifyInterventionFinished(appDeps, job.id),
      200,
    );
    const [job] = (await call<OpsJob[]>(`/offices/${office.id}/ops/jobs`)).body;
    await call(`/offices/${office.id}/ops/jobs/${job?.id}/decision`, "POST", { choice: "once" });
    const finished = await eventually(() =>
      sent.find((message) => message.subject === "Sysadmin: intervention completed"),
    );
    expect(finished.to).toBe("admin@example.com");
    expect(runs.map((run) => run.command)).toEqual(["systemctl restart nginx"]);
  }, 30_000);
});
