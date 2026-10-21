import { z } from "zod";
import { BUDGET_SCOPES, PROVIDER_BILLINGS } from "../costs";
import { issue } from "./issue";

// US dollars per million tokens: no model costs more than a few hundred.
const rateSchema = z
  .number(issue("invalid_value"))
  .min(0, issue("invalid_value"))
  .max(100_000, issue("invalid_value"));

export const providerBillingSchema = z.object({
  billing: z.enum(PROVIDER_BILLINGS),
});

// Saving a price for a model of a per-token provider (R-MOD-4); null rates remove it.
export const modelPriceSchema = z.object({
  providerId: z.uuid(issue("invalid_value")),
  model: z.string().trim().min(1, issue("required")).max(200, issue("too_long")),
  rates: z
    .object({
      input: rateSchema,
      cachedInput: rateSchema.nullable(),
      cacheWrite: rateSchema.nullable(),
      output: rateSchema,
    })
    .nullable(),
});

// A monthly limit in US dollars; scopeId is the office or the person, null for the installation.
export const budgetSchema = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    scopeId: z.uuid(issue("invalid_value")).nullable(),
    monthlyLimit: z
      .number(issue("invalid_value"))
      .positive(issue("invalid_value"))
      .max(1_000_000_000, issue("invalid_value")),
    warnPercent: z
      .number(issue("invalid_value"))
      .int(issue("invalid_value"))
      .min(1, issue("invalid_value"))
      .max(99, issue("invalid_value")),
  })
  .superRefine((value, ctx) => {
    if ((value.scope === "installation") !== (value.scopeId === null)) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: "invalid_value" });
    }
  });

export const costMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, issue("invalid_value"));
