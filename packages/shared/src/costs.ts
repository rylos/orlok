import type { z } from "zod";
import type { budgetSchema, modelPriceSchema } from "./schemas/costs";

// Model usage, prices and spending limits (R-MOD-4).

// What a model call was made for. Chat covers every step of a colleague's answer.
export const USAGE_PURPOSES = [
  "chat",
  "compaction",
  "wiki_filing",
  "wiki_reflection",
  "wiki_check",
  "wiki_search",
  "vision",
  "playground",
] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

// priced: the provider bills per token and the model has a price. included: the provider costs
// nothing per call (local models, subscriptions). unpriced: per token, but no price is known yet:
// never counted as zero.
export const COST_STATUSES = ["priced", "included", "unpriced"] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

export const PROVIDER_BILLINGS = ["per_token", "included"] as const;
export type ProviderBilling = (typeof PROVIDER_BILLINGS)[number];

export const BUDGET_SCOPES = ["installation", "office", "person"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const DEFAULT_BUDGET_WARN_PERCENT = 80;

// US dollars per million tokens. Cached input and cache writes are parts of the input that
// providers bill at their own rates; null means "same as input".
export type ModelRates = {
  input: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number;
};

export type ModelPrice = ModelRates & {
  providerId: string;
  model: string;
  updatedAt: string;
};

// Spend in a month for one group (an office, a person, a model, a purpose).
export type SpendLine = {
  key: string;
  // Office or person name, model id, purpose; null for an office or person deleted since.
  label: string | null;
  // Millionths of a US dollar; only priced calls.
  costMicros: number;
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type CostBudget = {
  id: string;
  scope: BudgetScope;
  // Office or person; null for the installation.
  scopeId: string | null;
  scopeName: string | null;
  monthlyLimitMicros: number;
  warnPercent: number;
  // Spend of the current month, priced calls only, and how many calls had no price.
  spentMicros: number;
  unpricedCalls: number;
};

// A model in use (by a profile or in the ledger) with its price, when it has one.
export type PriceEntry = {
  providerId: string;
  providerName: string;
  billing: ProviderBilling;
  model: string;
  rates: ModelRates | null;
  // Calls of this month made while it had no price.
  unpricedCalls: number;
};

export type CostProvider = {
  id: string;
  name: string;
  billing: ProviderBilling;
};

export type CostReport = {
  // First day of the month, YYYY-MM.
  month: string;
  totalMicros: number;
  calls: number;
  unpricedCalls: number;
  byOffice: SpendLine[];
  byPerson: SpendLine[];
  byModel: SpendLine[];
  byPurpose: SpendLine[];
};

export type CostOverview = {
  report: CostReport;
  budgets: CostBudget[];
  providers: CostProvider[];
  prices: PriceEntry[];
};

export function microsToDollars(micros: number) {
  return micros / 1_000_000;
}

export type ModelPriceInput = z.input<typeof modelPriceSchema>;
export type BudgetInput = z.input<typeof budgetSchema>;
