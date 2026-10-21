import {
  budgetSchema,
  costMonthSchema,
  modelPriceSchema,
  providerBillingSchema,
} from "@orlok/shared/schemas";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { budgets, modelPrices, modelProviders, offices, users } from "../../db/schema";
import { errorBody } from "../../lib/errors";
import { idParamSchema, validate } from "../../lib/validation";
import { audit } from "../../ops/audit";
import { costOverview, monthOf } from "../../services/costs";
import type { AppEnv, Deps } from "../../types";

const notFound = errorBody("not_found", "Not found");
const unknownScope = errorBody("validation_failed", "Unknown office or person", [
  { path: "scopeId", code: "invalid_value" },
]);

// Spend, prices and monthly limits (R-MOD-4), administrators only. Changes go to the
// installation log.
export function costRoutes({ db }: Deps) {
  return new Hono<AppEnv>()
    .get("/", validate("query", z.object({ month: costMonthSchema.optional() })), async (c) => {
      const { month } = c.req.valid("query");
      return c.json(await costOverview(db, month ?? monthOf(new Date())));
    })
    .put(
      "/providers/:id",
      validate("param", idParamSchema),
      validate("json", providerBillingSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const { billing } = c.req.valid("json");
        const [row] = await db
          .update(modelProviders)
          .set({ billing })
          .where(eq(modelProviders.id, id))
          .returning({ name: modelProviders.name });
        if (!row) {
          return c.json(notFound, 404);
        }
        await audit(db, {
          officeId: null,
          actor: { userId: c.get("user")?.id ?? "" },
          action: "cost.provider_billing",
          target: row.name,
          detail: { billing },
        });
        return c.body(null, 204);
      },
    )
    .put("/prices", validate("json", modelPriceSchema), async (c) => {
      const { providerId, model, rates } = c.req.valid("json");
      const [provider] = await db
        .select({ name: modelProviders.name })
        .from(modelProviders)
        .where(eq(modelProviders.id, providerId));
      if (!provider) {
        return c.json(notFound, 404);
      }
      if (rates) {
        await db
          .insert(modelPrices)
          .values({ providerId, model, rates })
          .onConflictDoUpdate({
            target: [modelPrices.providerId, modelPrices.model],
            set: { rates, updatedAt: new Date() },
          });
      } else {
        await db
          .delete(modelPrices)
          .where(and(eq(modelPrices.providerId, providerId), eq(modelPrices.model, model)));
      }
      await audit(db, {
        officeId: null,
        actor: { userId: c.get("user")?.id ?? "" },
        action: rates ? "cost.price_set" : "cost.price_removed",
        target: `${provider.name} / ${model}`,
        detail: rates ? { rates } : {},
      });
      return c.body(null, 204);
    })
    .put("/budgets", validate("json", budgetSchema), async (c) => {
      const input = c.req.valid("json");
      const officeId = input.scope === "office" ? input.scopeId : null;
      const userId = input.scope === "person" ? input.scopeId : null;
      if (officeId) {
        const [row] = await db
          .select({ id: offices.id })
          .from(offices)
          .where(eq(offices.id, officeId));
        if (!row) {
          return c.json(unknownScope, 400);
        }
      }
      if (userId) {
        const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
        if (!row) {
          return c.json(unknownScope, 400);
        }
      }
      const monthlyLimitMicros = Math.round(input.monthlyLimit * 1_000_000);
      // A new limit or threshold is notified again when crossed, even within the same month.
      await db
        .insert(budgets)
        .values({
          scope: input.scope,
          officeId,
          userId,
          monthlyLimitMicros,
          warnPercent: input.warnPercent,
        })
        .onConflictDoUpdate({
          target: [budgets.scope, budgets.officeId, budgets.userId],
          set: {
            monthlyLimitMicros,
            warnPercent: input.warnPercent,
            warnedMonth: null,
            exceededMonth: null,
            updatedAt: new Date(),
          },
        });
      await audit(db, {
        officeId: null,
        actor: { userId: c.get("user")?.id ?? "" },
        action: "cost.budget_set",
        target: input.scope,
        detail: {
          scope: input.scope,
          scopeId: input.scopeId,
          monthlyLimitMicros,
          warnPercent: input.warnPercent,
        },
      });
      return c.body(null, 204);
    })
    .delete("/budgets/:id", validate("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      const [row] = await db.delete(budgets).where(eq(budgets.id, id)).returning();
      if (!row) {
        return c.json(notFound, 404);
      }
      await audit(db, {
        officeId: null,
        actor: { userId: c.get("user")?.id ?? "" },
        action: "cost.budget_removed",
        target: row.scope,
        detail: { scope: row.scope, scopeId: row.officeId ?? row.userId },
      });
      return c.body(null, 204);
    });
}
