import type { ModelProvider, NotificationSettings, Office, TelegramLink } from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import {
  approvedCommandTypes,
  conversations,
  messages,
  opsJobs,
  opsPlans,
  telegramAccounts,
  users,
} from "../db/schema";
import type { LlmClientFactory } from "../llm";
import { requestJob } from "../ops/jobs";
import { requestPlan } from "../ops/plans";
import { liveEvents } from "../services/live-events";
import { notifyApprovalNeeded } from "../services/notifications";
import type { InlineButton, TelegramApi, TelegramUpdate } from "../telegram/api";
import { handleUpdate, type TelegramDeps } from "../telegram/bot";
import { createTestDeps, resetDatabase } from "../test/db";
import { createColleague, jsonRequest, parseSse, setupAdmin } from "../test/http";

// Telegram (R-CHAT-10, R-CHAT-12) with a stand-in for the Bot API: what Orlok sends is recorded.

const deps = createTestDeps();
type Sent = { chatId: number; text: string; buttons?: InlineButton[][]; html?: boolean };
const sent: Sent[] = [];
const edited: { chatId: number; messageId: number; text: string }[] = [];
const answered: { id: string; text?: string }[] = [];
const fakeApi: TelegramApi = {
  async getMe() {
    return { id: 1, is_bot: true, first_name: "Orlok", username: "orlok_test_bot" };
  },
  async deleteWebhook() {},
  async getUpdates() {
    return [];
  },
  async sendMessage(chatId, text, buttons, options) {
    sent.push({
      chatId,
      text,
      ...(buttons ? { buttons } : {}),
      ...(options?.html ? { html: true } : {}),
    });
    return { message_id: sent.length };
  },
  async editMessageText(chatId, messageId, text) {
    edited.push({ chatId, messageId, text });
  },
  async answerCallbackQuery(id, text) {
    answered.push({ id, ...(text ? { text } : {}) });
  },
  async setMyCommands() {},
};
const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat() {
    yield { type: "text", text: "Ciao, sono qui." };
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
});
const telegramDeps: TelegramDeps = { ...deps, llm: fakeLlm, telegram: () => fakeApi };
const app = createApp(telegramDeps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  sent.length = 0;
  edited.length = 0;
  answered.length = 0;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

let updateId = 0;
function message(chatId: number, text: string): TelegramUpdate {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: chatId, is_bot: false, first_name: "Luca", username: "luca" },
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function press(chatId: number, data: string): TelegramUpdate {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `q${updateId}`,
      from: { id: chatId, is_bot: false, first_name: "Luca" },
      message: { message_id: 1, chat: { id: chatId, type: "private" }, text: "Approval" },
      data,
    },
  };
}

async function linkedSetup() {
  const configured = await call<{ botUsername: string }>("/admin/telegram", "PUT", {
    token: "123456789:AAEexampleexampleexampleexampleexample",
  });
  expect(configured.body.botUsername).toBe("orlok_test_bot");
  const link = await call<{ url: string }>("/me/telegram/link", "POST");
  expect(link.body.url).toMatch(/^https:\/\/t\.me\/orlok_test_bot\?start=[A-Za-z0-9_-]+$/);
  const token = link.body.url.split("start=")[1] ?? "";
  await handleUpdate(telegramDeps, fakeApi, message(42, `/start ${token}`));
  // A link works once.
  await handleUpdate(telegramDeps, fakeApi, message(43, `/start ${token}`));
  return token;
}

describe("Telegram", () => {
  it("links an account with a one-time link and ignores strangers and groups", async () => {
    await handleUpdate(telegramDeps, fakeApi, message(42, "ciao"));
    expect(sent.at(-1)?.text).toContain("not linked");
    await linkedSetup();
    expect(sent.find((item) => item.chatId === 42 && item.text.startsWith("Linked"))).toBeTruthy();
    expect(sent.at(-1)).toMatchObject({ chatId: 43, text: expect.stringContaining("not valid") });
    const status = await call<TelegramLink>("/me/telegram");
    expect(status.body).toMatchObject({ available: true, linked: true, username: "luca" });

    const before = sent.length;
    const group = message(42, "ciao a tutti");
    if (group.message) {
      group.message.chat = { id: -100, type: "group" };
    }
    await handleUpdate(telegramDeps, fakeApi, group);
    expect(sent.length).toBe(before);

    expect((await call("/me/telegram", "DELETE")).res.status).toBe(204);
    expect(await deps.db.select().from(telegramAccounts)).toEqual([]);
  });

  it("talks with the person's colleague in an ordinary conversation", async () => {
    const provider = (
      await call<ModelProvider>("/admin/providers", "POST", {
        name: "P",
        kind: "anthropic",
        apiKey: "x",
      })
    ).body;
    const { id: profileId } = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "Ask",
        providerId: provider.id,
        model: "model",
        mode: "ask",
      })
    ).body;
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    await createColleague(app, deps.db, adminCookie, {
      officeId: office.id,
      profileId,
      name: "Mary",
    });
    await linkedSetup();

    // The person's open pages hear the answer start and end, and the deletion below.
    const [me] = await deps.db.select().from(users);
    const heard: unknown[] = [];
    const stopListening = liveEvents.subscribe(me?.id ?? "", (event) => heard.push(event));
    await handleUpdate(telegramDeps, fakeApi, message(42, "La stampante non va"));
    expect(sent.at(-1)).toEqual({ chatId: 42, text: "Ciao, sono qui.", html: true });
    const [first] = await deps.db.select().from(conversations);
    expect(heard).toEqual([
      { type: "conversation", colleagueId: first?.colleagueId, conversationId: first?.id },
      { type: "conversation", colleagueId: first?.colleagueId, conversationId: first?.id },
    ]);
    const stored = await deps.db.select().from(messages);
    expect(stored.map((row) => `${row.role}:${row.content}`)).toEqual([
      "user:La stampante non va",
      "assistant:Ciao, sono qui.",
    ]);
    // Written on the web in the same conversation: Telegram shows the message and the answer.
    const [current] = await deps.db.select().from(conversations);
    const fromWeb = await app.request(
      `/api/conversations/${current?.id}/messages`,
      jsonRequest("POST", { content: "E lo scanner <A3>?" }, adminCookie),
    );
    expect(parseSse(await fromWeb.text()).at(-1)?.type).toBe("done");
    expect(sent.slice(-2)).toEqual([
      { chatId: 42, text: "🖥 <i>From the web</i>\nE lo scanner &lt;A3&gt;?", html: true },
      { chatId: 42, text: "Ciao, sono qui.", html: true },
    ]);

    // The same conversation goes on until /new.
    await handleUpdate(telegramDeps, fakeApi, message(42, "/new"));
    expect(sent.at(-1)?.text).toContain("New conversation with Mary");
    await handleUpdate(telegramDeps, fakeApi, message(42, "Seconda domanda"));

    // Existing conversations can be listed, continued and deleted.
    await handleUpdate(telegramDeps, fakeApi, message(42, "/conversations"));
    const list = sent.at(-1)?.buttons ?? [];
    expect(list).toHaveLength(2);
    expect(list[0]?.[0]?.text).toMatch(/^• Seconda domanda · Mary/);
    const older = list[1]?.[0]?.callback_data?.slice(2) ?? "";
    await handleUpdate(telegramDeps, fakeApi, press(42, `v:${older}`));
    expect(sent.at(-2)?.text).toContain("Continuing “La stampante non va” with Mary");
    expect(sent.at(-1)?.text).toBe("Ciao, sono qui.");
    const [account] = await deps.db.select().from(telegramAccounts);
    expect(account?.conversationId).toBe(older);

    // Another chat cannot touch it; deleting asks first.
    await handleUpdate(telegramDeps, fakeApi, press(99, `X:${older}`));
    await handleUpdate(telegramDeps, fakeApi, press(42, `x:${older}`));
    expect(sent.at(-1)?.buttons?.[0]?.[0]).toEqual({ text: "Delete", callback_data: `X:${older}` });
    expect(
      await deps.db.select().from(conversations).where(eq(conversations.id, older)),
    ).toHaveLength(1);
    await handleUpdate(telegramDeps, fakeApi, press(42, `X:${older}`));
    expect(answered.at(-1)?.text).toBe("Conversation deleted.");
    expect(heard.at(-1)).toEqual({
      type: "conversation",
      colleagueId: first?.colleagueId,
      conversationId: older,
      deleted: true,
    });
    stopListening();
    expect(await deps.db.select().from(conversations).where(eq(conversations.id, older))).toEqual(
      [],
    );
  });

  it("approves once or denies from buttons, only for the person it was asked for", async () => {
    await linkedSetup();
    const provider = (
      await call<ModelProvider>("/admin/providers", "POST", {
        name: "P",
        kind: "anthropic",
        apiKey: "x",
      })
    ).body;
    const { id: profileId } = (
      await call<{ id: string }>("/admin/profiles", "POST", {
        name: "Ask",
        providerId: provider.id,
        model: "model",
        mode: "ask",
      })
    ).body;
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    const colleague = (
      await createColleague(app, deps.db, adminCookie, {
        officeId: office.id,
        profileId,
        name: "Mary",
      })
    ).body;
    const [admin] = await deps.db.select().from(users);
    const job = await requestJob(deps.db, {
      officeId: office.id,
      colleagueId: colleague.id,
      conversationId: null,
      userId: admin?.id ?? null,
      target: { kind: "runner" },
      command: "systemctl restart nginx",
      reason: "fix",
      timeoutSeconds: 30,
      policy: { mode: "ask" },
    });
    expect(job.status).toBe("pending_approval");

    await notifyApprovalNeeded(telegramDeps, {
      conversationId: null,
      colleagueId: colleague.id,
      requestedForUserId: admin?.id ?? "",
      what: job.command,
      reason: job.reason,
      jobId: job.id,
      types: job.classification.types ?? [],
    });
    const firstPrompt = sent.length;
    expect(job.classification.types).toEqual(["systemctl restart"]);
    expect(sent.at(-1)?.buttons).toEqual([
      [
        { text: "Allow once", callback_data: `j:${job.id}:o` },
        { text: "Deny", callback_data: `j:${job.id}:d` },
      ],
      [{ text: "Always allow: systemctl restart", callback_data: `j:${job.id}:a` }],
    ]);

    // Another chat cannot decide it.
    await handleUpdate(telegramDeps, fakeApi, press(99, `j:${job.id}:a`));
    expect((await deps.db.select().from(opsJobs).where(eq(opsJobs.id, job.id)))[0]?.status).toBe(
      "pending_approval",
    );
    // "Always" remembers the type for this person, as in the app.
    await handleUpdate(telegramDeps, fakeApi, press(42, `j:${job.id}:a`));
    expect(answered.at(-1)?.text).toContain("Always allowed for you");
    const [decided] = await deps.db.select().from(opsJobs).where(eq(opsJobs.id, job.id));
    expect(decided).toMatchObject({ status: "queued", decidedByUserId: admin?.id });
    const remembered = await deps.db
      .select()
      .from(approvedCommandTypes)
      .where(eq(approvedCommandTypes.userId, admin?.id ?? ""));
    expect(remembered.map((row) => row.type)).toEqual(["systemctl restart"]);
    // The request on Telegram shows the outcome instead of its buttons.
    expect(edited.find((edit) => edit.messageId === firstPrompt)?.text).toMatch(
      /\n\n✅ Approved by \S/,
    );

    // Decided on the web: the Telegram message follows.
    const second = await requestJob(deps.db, {
      officeId: office.id,
      colleagueId: colleague.id,
      conversationId: null,
      userId: admin?.id ?? null,
      target: { kind: "runner" },
      command: "reboot",
      reason: "fix",
      timeoutSeconds: 30,
      policy: { mode: "ask" },
    });
    await notifyApprovalNeeded(telegramDeps, {
      conversationId: null,
      colleagueId: colleague.id,
      requestedForUserId: admin?.id ?? "",
      what: second.command,
      reason: second.reason,
      jobId: second.id,
      types: second.classification.types ?? [],
    });
    const promptId = sent.length;
    const decision = await call(`/offices/${office.id}/ops/jobs/${second.id}/decision`, "POST", {
      choice: "deny",
    });
    expect(decision.res.status).toBe(200);
    await vi.waitFor(() =>
      expect(edited.at(-1)).toMatchObject({
        chatId: 42,
        messageId: promptId,
        text: expect.stringContaining("❌ Denied by "),
      }),
    );

    // A plan can be approved always allowing its steps' types, as in the app.
    const { plan } = await requestPlan(deps.db, {
      officeId: office.id,
      colleagueId: colleague.id,
      conversationId: null,
      userId: admin?.id ?? null,
      title: "Restart the proxy",
      summary: null,
      steps: [
        {
          target: { kind: "runner" },
          command: "systemctl stop nginx",
          reason: "stop",
          timeoutSeconds: 30,
        },
        { target: { kind: "runner" }, command: "uptime", reason: "check", timeoutSeconds: 30 },
      ],
      policy: { mode: "ask" },
    });
    await notifyApprovalNeeded(telegramDeps, {
      conversationId: null,
      colleagueId: colleague.id,
      requestedForUserId: admin?.id ?? "",
      what: plan.title,
      reason: "stop and check",
      planId: plan.id,
      types: ["systemctl stop"],
    });
    expect(sent.at(-1)?.buttons).toEqual([
      [
        { text: "Approve the plan", callback_data: `p:${plan.id}:a` },
        { text: "Deny", callback_data: `p:${plan.id}:d` },
      ],
      [
        {
          text: "Approve and always allow: systemctl stop",
          callback_data: `p:${plan.id}:s`,
        },
      ],
    ]);
    await handleUpdate(telegramDeps, fakeApi, press(99, `p:${plan.id}:s`));
    expect(
      (await deps.db.select().from(opsPlans).where(eq(opsPlans.id, plan.id)))[0]?.decidedByUserId,
    ).toBeNull();
    await handleUpdate(telegramDeps, fakeApi, press(42, `p:${plan.id}:s`));
    expect(answered.at(-1)?.text).toContain("systemctl stop");
    const always = await deps.db
      .select()
      .from(approvedCommandTypes)
      .where(eq(approvedCommandTypes.userId, admin?.id ?? ""));
    expect(always.map((row) => row.type).sort()).toEqual(["systemctl restart", "systemctl stop"]);

    // Notifications can be turned off.
    const settings = await call<NotificationSettings>("/me/notifications", "PATCH", {
      telegram: false,
    });
    expect(settings.body.telegram).toBe(false);
  });
});
