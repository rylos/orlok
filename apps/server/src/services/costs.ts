import type {
  BudgetScope,
  CostBudget,
  CostOverview,
  CostReport,
  CostStatus,
  ModelRates,
  PriceEntry,
  ProviderBilling,
  SpendLine,
  TokenUsage,
  UsagePurpose,
} from "@orlok/shared";
import { and, asc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  budgets,
  modelPrices,
  modelProfiles,
  modelProviders,
  modelUsage,
  offices,
  users,
} from "../db/schema";
import type { LlmClient } from "../llm";
import { audit } from "../ops/audit";
import type { Deps } from "../types";
import { getSetupStatus } from "./installation";
import { notifyBudget } from "./notifications";

// Model usage, prices and monthly spending limits (R-MOD-4). Every model call the server makes
// goes through metered(): it is refused when a limit is reached, and its usage is written to the
// ledger with the prices of that moment. Unknown prices stay unknown, never zero.

// Without mail and push (some background callers in tests) limits still apply, unnotified.
type CostDeps = Pick<Deps, "db" | "config"> & Partial<Pick<Deps, "mail" | "push">>;

export class BudgetExceededError extends Error {
  constructor(message = "A monthly spending limit was reached") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export type UsageMeter = {
  purpose: UsagePurpose;
  provider: { id: string; name: string; billing: ProviderBilling };
  officeId?: string | null;
  userId?: string | null;
  colleagueId?: string | null;
  conversationId?: string | null;
  // The playground is metered but never stopped: it is how an administrator tests a provider.
  enforce?: boolean;
};

// Rates are US dollars per million tokens, so tokens × rate is millionths of a dollar.
export function costMicros(usage: TokenUsage, rates: ModelRates) {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - cached - written);
  return Math.round(
    plain * rates.input +
      cached * (rates.cachedInput ?? rates.input) +
      written * (rates.cacheWrite ?? rates.input) +
      usage.outputTokens * rates.output,
  );
}

// Calendar months in UTC, written YYYY-MM.
export function monthOf(date: Date) {
  return date.toISOString().slice(0, 7);
}

export function monthRange(month: string) {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(year, number - 1, 1)),
    end: new Date(Date.UTC(year, number, 1)),
  };
}

type BudgetRow = typeof budgets.$inferSelect;

// The limits a call made in this office for this person falls under.
async function applicableBudgets(
  db: Db,
  scope: { officeId?: string | null; userId?: string | null },
): Promise<BudgetRow[]> {
  const conditions: SQL[] = [eq(budgets.scope, "installation")];
  if (scope.officeId) {
    conditions.push(and(eq(budgets.scope, "office"), eq(budgets.officeId, scope.officeId)) as SQL);
  }
  if (scope.userId) {
    conditions.push(and(eq(budgets.scope, "person"), eq(budgets.userId, scope.userId)) as SQL);
  }
  return db
    .select()
    .from(budgets)
    .where(or(...conditions));
}

function budgetFilter(budget: Pick<BudgetRow, "scope" | "officeId" | "userId">) {
  if (budget.scope === "office" && budget.officeId) {
    return eq(modelUsage.officeId, budget.officeId);
  }
  if (budget.scope === "person" && budget.userId) {
    return eq(modelUsage.userId, budget.userId);
  }
  return undefined;
}

// Priced spend and unpriced calls of the month under a limit.
async function spendUnder(
  db: Db,
  budget: Pick<BudgetRow, "scope" | "officeId" | "userId">,
  month: string,
) {
  const { start, end } = monthRange(month);
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${modelUsage.costMicros}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${modelUsage.costStatus} = 'unpriced')::int`,
    })
    .from(modelUsage)
    .where(
      and(gte(modelUsage.createdAt, start), lt(modelUsage.createdAt, end), budgetFilter(budget)),
    );
  return { spentMicros: Number(row?.spent ?? 0), unpricedCalls: row?.unpriced ?? 0 };
}

// The first limit already reached, or null. Checked before every model call, so a long answer or
// a document being filed stops at its next call once a limit is reached.
export async function exceededBudget(
  db: Db,
  scope: { officeId?: string | null; userId?: string | null },
  now = new Date(),
) {
  for (const budget of await applicableBudgets(db, scope)) {
    const { spentMicros } = await spendUnder(db, budget, monthOf(now));
    if (spentMicros >= budget.monthlyLimitMicros) {
      return budget;
    }
  }
  return null;
}

async function scopeName(db: Db, budget: Pick<BudgetRow, "scope" | "officeId" | "userId">) {
  if (budget.scope === "office" && budget.officeId) {
    const [row] = await db
      .select({ name: offices.name })
      .from(offices)
      .where(eq(offices.id, budget.officeId));
    return row?.name ?? null;
  }
  if (budget.scope === "person" && budget.userId) {
    const [row] = await db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, budget.userId));
    return row?.name ?? null;
  }
  return (await getSetupStatus(db)).companyName ?? "Orlok";
}

// After a priced call: tells administrators, once per limit and month, that a limit is close or
// reached. The month is claimed with a conditional update, so two calls never notify twice.
async function checkThresholds(deps: CostDeps, meter: UsageMeter, now: Date) {
  const month = monthOf(now);
  for (const budget of await applicableBudgets(deps.db, meter)) {
    const { spentMicros } = await spendUnder(deps.db, budget, month);
    const exceeded = spentMicros >= budget.monthlyLimitMicros;
    const warned = spentMicros >= (budget.monthlyLimitMicros * budget.warnPercent) / 100;
    if (!exceeded && !warned) {
      continue;
    }
    const column = exceeded ? budgets.exceededMonth : budgets.warnedMonth;
    const claimed = await deps.db
      .update(budgets)
      .set(exceeded ? { exceededMonth: month, warnedMonth: month } : { warnedMonth: month })
      .where(and(eq(budgets.id, budget.id), or(isNull(column), sql`${column} <> ${month}`)))
      .returning({ id: budgets.id });
    if (claimed.length === 0) {
      continue;
    }
    const name = (await scopeName(deps.db, budget)) ?? "?";
    await audit(deps.db, {
      officeId: null,
      actor: null,
      action: exceeded ? "budget.exceeded" : "budget.warning",
      target: name,
      detail: {
        scope: budget.scope,
        month,
        spentMicros,
        limitMicros: budget.monthlyLimitMicros,
      },
    });
    if (!deps.mail || !deps.push) {
      continue;
    }
    await notifyBudget(
      { ...deps, mail: deps.mail, push: deps.push },
      {
        scopeName: name,
        spentMicros,
        limitMicros: budget.monthlyLimitMicros,
        exceeded,
      },
    );
  }
}

// Writes one model call to the ledger. A failure is logged and never fails the answer.
export async function recordUsage(
  deps: CostDeps,
  meter: UsageMeter,
  model: string,
  usage: TokenUsage | null,
  now = new Date(),
) {
  let costStatus: CostStatus = "unpriced";
  let rates: ModelRates | null = null;
  if (meter.provider.billing === "included") {
    costStatus = "included";
  } else if (usage) {
    const [price] = await deps.db
      .select({ rates: modelPrices.rates })
      .from(modelPrices)
      .where(and(eq(modelPrices.providerId, meter.provider.id), eq(modelPrices.model, model)));
    if (price) {
      costStatus = "priced";
      rates = price.rates;
    }
  }
  await deps.db.insert(modelUsage).values({
    officeId: meter.officeId ?? null,
    userId: meter.userId ?? null,
    colleagueId: meter.colleagueId ?? null,
    conversationId: meter.conversationId ?? null,
    purpose: meter.purpose,
    providerId: meter.provider.id,
    providerName: meter.provider.name,
    model,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costStatus,
    costMicros: rates && usage ? costMicros(usage, rates) : null,
    rates,
    createdAt: now,
  });
  if (costStatus === "priced") {
    await checkThresholds(deps, meter, now);
  }
}

// The same client, with each call checked against the limits and written to the ledger. Only
// calls that reach their end are recorded: a stream cut short reports no usage to record.
export function metered(deps: CostDeps, client: LlmClient, meter: UsageMeter): LlmClient {
  return {
    listModels: () => client.listModels(),
    ...(client.embed ? { embed: client.embed.bind(client) } : {}),
    async *streamChat(request) {
      if (meter.enforce !== false && (await exceededBudget(deps.db, meter))) {
        throw new BudgetExceededError();
      }
      for await (const chunk of client.streamChat(request)) {
        if (chunk.type === "done") {
          await recordUsage(deps, meter, request.model, chunk.usage).catch((error: unknown) => {
            console.error("Recording model usage failed", error);
          });
        }
        yield chunk;
      }
    },
  };
}

// Admin → Costs (R-MOD-4).

async function spendBy(
  db: Db,
  month: string,
  key: SQL,
  label: SQL,
  join?: (query: ReturnType<typeof baseSpend>) => ReturnType<typeof baseSpend>,
): Promise<SpendLine[]> {
  const { start, end } = monthRange(month);
  let query = baseSpend(db, key, label);
  if (join) {
    query = join(query);
  }
  const rows = await query
    .where(and(gte(modelUsage.createdAt, start), lt(modelUsage.createdAt, end)))
    .groupBy(key, label)
    .orderBy(sql`3 desc`, sql`4 desc`);
  return rows.map((row) => ({
    key: row.key ?? "",
    label: row.label,
    costMicros: Number(row.costMicros),
    calls: row.calls,
    unpricedCalls: row.unpricedCalls,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
  }));
}

function baseSpend(db: Db, key: SQL, label: SQL) {
  return db
    .select({
      key: sql<string | null>`${key}`.as("key"),
      label: sql<string | null>`${label}`.as("label"),
      costMicros: sql<string>`coalesce(sum(${modelUsage.costMicros}), 0)`.as("cost_micros"),
      calls: sql<number>`count(*)::int`.as("calls"),
      unpricedCalls:
        sql<number>`count(*) filter (where ${modelUsage.costStatus} = 'unpriced')::int`.as(
          "unpriced_calls",
        ),
      inputTokens: sql<string>`coalesce(sum(${modelUsage.inputTokens}), 0)`.as("input_tokens"),
      outputTokens: sql<string>`coalesce(sum(${modelUsage.outputTokens}), 0)`.as("output_tokens"),
    })
    .from(modelUsage)
    .$dynamic();
}

export async function costReport(db: Db, month: string): Promise<CostReport> {
  const byOffice = await spendBy(
    db,
    month,
    sql`${modelUsage.officeId}::text`,
    sql`${offices.name}`,
    (query) => query.leftJoin(offices, eq(modelUsage.officeId, offices.id)),
  );
  const byPerson = await spendBy(
    db,
    month,
    sql`${modelUsage.userId}::text`,
    sql`${users.displayName}`,
    (query) => query.leftJoin(users, eq(modelUsage.userId, users.id)),
  );
  const byModel = await spendBy(
    db,
    month,
    sql`${modelUsage.providerName} || ' / ' || ${modelUsage.model}`,
    sql`${modelUsage.providerName} || ' / ' || ${modelUsage.model}`,
  );
  const byPurpose = await spendBy(
    db,
    month,
    sql`${modelUsage.purpose}`,
    sql`${modelUsage.purpose}`,
  );
  const sum = (lines: SpendLine[], pick: (line: SpendLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  return {
    month,
    totalMicros: sum(byPurpose, (line) => line.costMicros),
    calls: sum(byPurpose, (line) => line.calls),
    unpricedCalls: sum(byPurpose, (line) => line.unpricedCalls),
    byOffice,
    byPerson,
    byModel,
    byPurpose,
  };
}

export async function listBudgets(db: Db, now = new Date()): Promise<CostBudget[]> {
  const rows = await db.select().from(budgets).orderBy(asc(budgets.createdAt));
  const result: CostBudget[] = [];
  for (const row of rows) {
    const spend = await spendUnder(db, row, monthOf(now));
    result.push({
      id: row.id,
      scope: row.scope,
      scopeId: row.officeId ?? row.userId,
      scopeName: row.scope === "installation" ? null : await scopeName(db, row),
      monthlyLimitMicros: row.monthlyLimitMicros,
      warnPercent: row.warnPercent,
      ...spend,
    });
  }
  const order: Record<BudgetScope, number> = { installation: 0, office: 1, person: 2 };
  return result.sort(
    (a, b) =>
      order[a.scope] - order[b.scope] || (a.scopeName ?? "").localeCompare(b.scopeName ?? ""),
  );
}

// The models of every profile and every model called this month, with their price.
export async function listPrices(db: Db, month: string): Promise<PriceEntry[]> {
  const { start, end } = monthRange(month);
  const providers = await db.select().from(modelProviders).orderBy(asc(modelProviders.name));
  const profiles = await db
    .selectDistinct({ providerId: modelProfiles.providerId, model: modelProfiles.model })
    .from(modelProfiles);
  const used = await db
    .select({
      providerId: modelUsage.providerId,
      model: modelUsage.model,
      unpriced: sql<number>`count(*) filter (where ${modelUsage.costStatus} = 'unpriced')::int`,
    })
    .from(modelUsage)
    .where(and(gte(modelUsage.createdAt, start), lt(modelUsage.createdAt, end)))
    .groupBy(modelUsage.providerId, modelUsage.model);
  const prices = providers.length
    ? await db
        .select()
        .from(modelPrices)
        .where(
          inArray(
            modelPrices.providerId,
            providers.map((provider) => provider.id),
          ),
        )
    : [];

  const entries = new Map<string, PriceEntry>();
  const add = (providerId: string | null, model: string) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || entries.has(`${provider.id}\n${model}`)) {
      return;
    }
    const price = prices.find((item) => item.providerId === provider.id && item.model === model);
    entries.set(`${provider.id}\n${model}`, {
      providerId: provider.id,
      providerName: provider.name,
      billing: provider.billing,
      model,
      rates: price?.rates ?? null,
      unpricedCalls: 0,
    });
  };
  for (const row of profiles) add(row.providerId, row.model);
  for (const row of used) add(row.providerId, row.model);
  for (const row of prices) add(row.providerId, row.model);
  for (const row of used) {
    const entry = entries.get(`${row.providerId}\n${row.model}`);
    if (entry) {
      entry.unpricedCalls += row.unpriced;
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model),
  );
}

export async function costOverview(db: Db, month: string): Promise<CostOverview> {
  const providers = await db
    .select({ id: modelProviders.id, name: modelProviders.name, billing: modelProviders.billing })
    .from(modelProviders)
    .orderBy(asc(modelProviders.name));
  return {
    report: await costReport(db, month),
    budgets: await listBudgets(db),
    providers,
    prices: await listPrices(db, month),
  };
}
