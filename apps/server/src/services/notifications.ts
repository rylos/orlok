import type { Locale } from "@orlok/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  colleagues,
  offices,
  opsPlans,
  pushSubscriptions,
  telegramAccounts,
  telegramPrompts,
  users,
} from "../db/schema";
import { approvalNotice, budgetNotice, finishedNotice, type Notice } from "../mail";
import { findJobRow, PLAN_FINISHED_STATUSES } from "../ops/jobs";
import type { InlineButton } from "../telegram/api";
import { getTelegramBot } from "../telegram/settings";
import type { Deps } from "../types";
import { getVapidKeys } from "./push";
import { getSmtpConnection } from "./smtp";

// Notifications to people (R-CHAT-7): both approvals and finished interventions go to the person
// who asked, the only one who sees the conversation they belong to. Failures are logged, never
// raised to the caller.

type NotifyDeps = Pick<Deps, "db" | "config" | "mail" | "push"> & Partial<Pick<Deps, "telegram">>;

type Recipient = {
  id: string;
  email: string;
  locale: Locale;
  notifyByEmail: boolean;
  notifyByPush: boolean;
  notifyByTelegram: boolean;
};

const recipientColumns = {
  id: users.id,
  email: users.email,
  locale: users.locale,
  notifyByEmail: users.notifyByEmail,
  notifyByPush: users.notifyByPush,
  notifyByTelegram: users.notifyByTelegram,
};

// Buttons under a Telegram notification, in the recipient's language (R-CHAT-10).
type TelegramButtons = (locale: Locale) => InlineButton[][];
// The request a Telegram message asks to decide: rewritten with the outcome once decided.
type Prompt = { jobId?: string; planId?: string };

async function deliver(
  deps: NotifyDeps,
  recipients: Recipient[],
  build: (locale: Locale, url: string) => Notice,
  path: string,
  tag: string,
  buttons?: TelegramButtons,
  prompt?: Prompt,
) {
  const { db, config } = deps;
  await deliverTelegram(deps, recipients, build, path, buttons, prompt).catch((error: unknown) => {
    console.error("Telegram notification failed", error);
  });
  const smtp = recipients.some((recipient) => recipient.notifyByEmail)
    ? await getSmtpConnection(db, config.secretKey)
    : null;
  const pushUserIds = recipients.filter((recipient) => recipient.notifyByPush).map((r) => r.id);
  const subscriptions =
    pushUserIds.length > 0
      ? await db
          .select()
          .from(pushSubscriptions)
          .where(inArray(pushSubscriptions.userId, pushUserIds))
      : [];
  const vapid =
    subscriptions.length > 0 ? await getVapidKeys(db, config.secretKey, config.publicUrl) : null;

  for (const recipient of recipients) {
    const notice = build(recipient.locale, `${config.publicUrl}${path}`);
    if (smtp && recipient.notifyByEmail) {
      try {
        await deps.mail(smtp).send({
          to: recipient.email,
          subject: notice.subject,
          text: notice.text,
          html: notice.html,
        });
      } catch (error) {
        console.error("Notification email failed", error);
      }
    }
    if (!vapid || !recipient.notifyByPush) {
      continue;
    }
    const payload = JSON.stringify({
      title: notice.pushTitle,
      body: notice.pushBody,
      url: path,
      tag,
    });
    for (const subscription of subscriptions.filter((item) => item.userId === recipient.id)) {
      try {
        await deps.push(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          vapid,
        );
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        // The browser unsubscribed or the subscription expired.
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
        } else {
          console.error("Push notification failed", error);
        }
      }
    }
  }
}

// Telegram, for people who linked an account and keep it on: the notice, a link to the page and,
// for an approval that may be decided from a chat, its buttons.
async function deliverTelegram(
  deps: NotifyDeps,
  recipients: Recipient[],
  build: (locale: Locale, url: string) => Notice,
  path: string,
  buttons?: TelegramButtons,
  prompt?: Prompt,
) {
  const wanted = recipients.filter((recipient) => recipient.notifyByTelegram);
  if (!deps.telegram || wanted.length === 0) {
    return;
  }
  const accounts = await deps.db
    .select({ userId: telegramAccounts.userId, chatId: telegramAccounts.chatId })
    .from(telegramAccounts)
    .where(
      inArray(
        telegramAccounts.userId,
        wanted.map((recipient) => recipient.id),
      ),
    );
  if (accounts.length === 0) {
    return;
  }
  const bot = await getTelegramBot(deps.db, deps.config.secretKey);
  if (!bot) {
    return;
  }
  const api = deps.telegram(bot.token);
  for (const recipient of wanted) {
    const account = accounts.find((item) => item.userId === recipient.id);
    if (!account) {
      continue;
    }
    const url = `${deps.config.publicUrl}${path}`;
    const notice = build(recipient.locale, url);
    const body = `${notice.pushTitle}\n\n${notice.pushBody}\n\n${url}`;
    const sent = await api.sendMessage(account.chatId, body, buttons?.(recipient.locale));
    if (prompt && (prompt.jobId || prompt.planId)) {
      await deps.db.insert(telegramPrompts).values({
        userId: recipient.id,
        chatId: account.chatId,
        messageId: sent.message_id,
        jobId: prompt.jobId ?? null,
        planId: prompt.planId ?? null,
        text: body,
      });
    }
  }
}

async function colleagueWithOffice(db: Db, colleagueId: string) {
  const [row] = await db
    .select({ colleagueName: colleagues.name, officeId: offices.id, officeName: offices.name })
    .from(colleagues)
    .innerJoin(offices, eq(colleagues.officeId, offices.id))
    .where(eq(colleagues.id, colleagueId))
    .limit(1);
  return row ?? null;
}

function conversationPath(colleagueId: string, conversationId: string | null) {
  return conversationId ? `/colleagues/${colleagueId}/${conversationId}` : "/";
}

// The person an intervention was requested for, when they can still be reached.
async function recipientById(db: Db, userId: string): Promise<Recipient[]> {
  return db
    .select(recipientColumns)
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)));
}

// Only the person whose conversation it is (R-OPS-4): the job card lives in that conversation,
// which nobody else can open, so notifying anyone else would lead to a page they cannot see.
export async function notifyApprovalNeeded(
  deps: NotifyDeps,
  input: {
    conversationId: string | null;
    colleagueId: string;
    requestedForUserId: string;
    what: string;
    reason: string;
    jobId?: string;
    planId?: string;
    onceOnly?: boolean;
    // Command types "always" would remember; none means only once (R-OPS-4).
    types?: string[];
  },
) {
  const context = await colleagueWithOffice(deps.db, input.colleagueId);
  if (!context) {
    return;
  }
  await deliver(
    deps,
    await recipientById(deps.db, input.requestedForUserId),
    (locale, url) =>
      approvalNotice({
        locale,
        colleagueName: context.colleagueName,
        officeName: context.officeName,
        what: input.what,
        reason: input.reason,
        url,
      }),
    conversationPath(input.colleagueId, input.conversationId),
    `approval-${input.conversationId ?? input.colleagueId}`,
    // "Once" and "deny" only: "always", and what is approved once each time, stay in the app.
    input.onceOnly
      ? undefined
      : (locale) => {
          const it = locale === "it";
          if (input.planId) {
            return [
              [
                {
                  text: it ? "Approva il piano" : "Approve the plan",
                  callback_data: `p:${input.planId}:a`,
                },
                { text: it ? "Nega" : "Deny", callback_data: `p:${input.planId}:d` },
              ],
              // Like the app's "approve and always allow": the steps' types, for this person only.
              ...(input.types?.length
                ? [
                    [
                      {
                        text: `${it ? "Approva e consenti sempre" : "Approve and always allow"}: ${input.types.join(", ")}`.slice(
                          0,
                          64,
                        ),
                        callback_data: `p:${input.planId}:s`,
                      },
                    ],
                  ]
                : []),
            ];
          }
          if (!input.jobId) {
            return [];
          }
          const types = input.types ?? [];
          return [
            [
              {
                text: it ? "Consenti una volta" : "Allow once",
                callback_data: `j:${input.jobId}:o`,
              },
              { text: it ? "Nega" : "Deny", callback_data: `j:${input.jobId}:d` },
            ],
            // Like the app: "always" remembers the types for this person only.
            ...(types.length > 0
              ? [
                  [
                    {
                      text: `${it ? "Consenti sempre" : "Always allow"}: ${types.join(", ")}`.slice(
                        0,
                        64,
                      ),
                      callback_data: `j:${input.jobId}:a`,
                    },
                  ],
                ]
              : []),
          ];
        },
    {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
    },
  );
}

// Called when a job run by the background worker ends: tells the person who asked, once per
// command or once per plan.
export async function notifyInterventionFinished(deps: NotifyDeps, jobId: string) {
  const job = await findJobRow(deps.db, jobId);
  if (!job?.requestedForUserId || !job.colleagueId) {
    return;
  }
  let what = job.command;
  let success = job.status === "done" && (job.exitCode ?? 0) === 0;
  if (job.planId) {
    const [plan] = await deps.db
      .select()
      .from(opsPlans)
      .where(eq(opsPlans.id, job.planId))
      .limit(1);
    if (!plan || !PLAN_FINISHED_STATUSES.includes(plan.status)) {
      return;
    }
    what = plan.title;
    success = plan.status === "done";
  }
  const context = await colleagueWithOffice(deps.db, job.colleagueId);
  const recipients = await recipientById(deps.db, job.requestedForUserId);
  if (!context || recipients.length === 0) {
    return;
  }
  await deliver(
    deps,
    recipients,
    (locale, url) =>
      finishedNotice({ locale, colleagueName: context.colleagueName, what, success, url }),
    conversationPath(job.colleagueId, job.conversationId),
    `finished-${job.planId ?? job.id}`,
  );
}

function formatDollars(micros: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
    micros / 1_000_000,
  );
}

// A monthly spending limit was approached or reached (R-MOD-4): every administrator is told,
// once per limit and month, since only they can raise it.
export async function notifyBudget(
  deps: NotifyDeps,
  input: { scopeName: string; spentMicros: number; limitMicros: number; exceeded: boolean },
) {
  const admins = await deps.db
    .select(recipientColumns)
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.disabledAt)));
  await deliver(
    deps,
    admins,
    (locale, url) =>
      budgetNotice({
        locale,
        scopeName: input.scopeName,
        spent: formatDollars(input.spentMicros, locale),
        limit: formatDollars(input.limitMicros, locale),
        exceeded: input.exceeded,
        url,
      }),
    "/admin/costs",
    `budget-${input.scopeName}`,
  );
}
