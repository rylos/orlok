import type { Locale } from "@orlok/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { opsJobs, opsPlans, telegramPrompts, users } from "../db/schema";
import type { Deps } from "../types";
import type { TelegramApi } from "./api";
import { getTelegramBot } from "./settings";

// Approval requests on Telegram follow the decision wherever it is taken (R-CHAT-12): approved or
// denied on the web, from Telegram, or cancelled because the colleague's profile changed, the
// message is rewritten with the outcome and its buttons go. Called right after a decision, and
// by the Telegram worker between polls for the decisions nobody announced.

const TEXT = {
  en: {
    approved: (name: string | null) => (name ? `✅ Approved by ${name}.` : "✅ Approved."),
    denied: (name: string | null) => (name ? `❌ Denied by ${name}.` : "❌ Denied."),
    cancelled: "⏹ No longer waiting: cancelled.",
    expired: "⌛ Expired.",
  },
  it: {
    approved: (name: string | null) => (name ? `✅ Approvato da ${name}.` : "✅ Approvato."),
    denied: (name: string | null) => (name ? `❌ Negato da ${name}.` : "❌ Negato."),
    cancelled: "⏹ Non più in attesa: annullato.",
    expired: "⌛ Scaduto.",
  },
} as const;

type Decision = { status: string; decidedBy: string | null };

function outcome(decision: Decision, locale: Locale) {
  const t = locale === "it" ? TEXT.it : TEXT.en;
  if (decision.status === "denied") {
    return t.denied(decision.decidedBy);
  }
  if (decision.status === "expired") {
    return t.expired;
  }
  // Stopped before anyone decided: cancelled, e.g. because the colleague's profile changed.
  if (decision.status === "stopped" && !decision.decidedBy) {
    return t.cancelled;
  }
  return t.approved(decision.decidedBy);
}

// Rewrites the prompts whose request is no longer waiting; returns the Telegram messages it
// settled, so the bot does not write the outcome a second time.
export async function settlePrompts(
  deps: Pick<Deps, "db" | "config" | "telegram">,
  api?: TelegramApi,
) {
  const settled = new Set<string>();
  const prompts = await deps.db
    .select({ prompt: telegramPrompts, locale: users.locale })
    .from(telegramPrompts)
    .innerJoin(users, eq(telegramPrompts.userId, users.id));
  if (prompts.length === 0) {
    return settled;
  }
  const jobIds = prompts.flatMap(({ prompt }) => (prompt.jobId ? [prompt.jobId] : []));
  const planIds = prompts.flatMap(({ prompt }) => (prompt.planId ? [prompt.planId] : []));
  const decidedBy = sql<
    string | null
  >`(select display_name from users where id = decided_by_user_id)`;
  const jobs = jobIds.length
    ? await deps.db
        .select({ id: opsJobs.id, status: opsJobs.status, decidedBy })
        .from(opsJobs)
        .where(inArray(opsJobs.id, jobIds))
    : [];
  const plans = planIds.length
    ? await deps.db
        .select({ id: opsPlans.id, status: opsPlans.status, decidedBy })
        .from(opsPlans)
        .where(inArray(opsPlans.id, planIds))
    : [];
  const decisions = new Map<string, Decision>([...jobs, ...plans].map((row) => [row.id, row]));

  let client = api;
  for (const { prompt, locale } of prompts) {
    const decision = decisions.get(prompt.planId ?? prompt.jobId ?? "");
    if (decision?.status === "pending_approval") {
      continue;
    }
    if (!client) {
      const bot = await getTelegramBot(deps.db, deps.config.secretKey);
      if (!bot) {
        return settled;
      }
      client = deps.telegram(bot.token);
    }
    // Gone (deleted with its conversation): nothing left to say, only the buttons to take away.
    const line = decision ? outcome(decision, locale) : null;
    await client
      .editMessageText(
        prompt.chatId,
        prompt.messageId,
        line ? `${prompt.text}\n\n${line}` : prompt.text,
      )
      .catch(() => undefined);
    await deps.db.delete(telegramPrompts).where(eq(telegramPrompts.id, prompt.id));
    settled.add(`${prompt.chatId}:${prompt.messageId}`);
  }
  return settled;
}

// After a decision taken in the app: the Telegram side follows at once, never failing the caller.
export function settlePromptsSoon(deps: Pick<Deps, "db" | "config" | "telegram">) {
  void settlePrompts(deps).catch((error: unknown) => {
    console.error("Telegram approval update failed", error);
  });
}
