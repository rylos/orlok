import type {
  BudgetScope,
  CostBudget,
  ModelRates,
  PriceEntry,
  ProviderBilling,
  SpendLine,
} from "@orlok/shared";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { useAdminOffices, usePeople } from "@/lib/admin-queries";
import {
  useCosts,
  useDeleteBudget,
  useSaveBudget,
  useSavePrice,
  useSetProviderBilling,
} from "@/lib/cost-queries";
import { cn } from "@/lib/utils";

// Spend of the month, monthly limits and model prices (R-MOD-4). Not by colleague: colleagues
// are private to their owner, administrators included (R-ADM-3).

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function formatMoney(micros: number) {
  const dollars = micros / 1_000_000;
  return new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: dollars !== 0 && Math.abs(dollars) < 1 ? 4 : 2,
  }).format(dollars);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
}

export function CostsPage() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(currentMonth);
  const costs = useCosts(month);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("costs.title")}</h1>
          <p className="text-muted-foreground">{t("costs.description")}</p>
        </div>
        <div className="w-44">
          <FormField id="costs-month" label={t("costs.month")}>
            <Input
              id="costs-month"
              type="month"
              value={month}
              max={currentMonth()}
              onChange={(event) => event.target.value && setMonth(event.target.value)}
            />
          </FormField>
        </div>
      </div>

      {costs.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : costs.isError ? (
        <ErrorAlert>{translateError(t, costs.error)}</ErrorAlert>
      ) : (
        <>
          <Summary
            totalMicros={costs.data.report.totalMicros}
            calls={costs.data.report.calls}
            unpricedCalls={costs.data.report.unpricedCalls}
          />
          <section aria-labelledby="costs-spend-title" className="space-y-4">
            <SectionHeader
              id="costs-spend-title"
              title={t("costs.spend.title")}
              description={t("costs.spend.description")}
            />
            {costs.data.report.calls === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("costs.spend.empty")}
              </p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <SpendTable title={t("costs.spend.byOffice")} lines={costs.data.report.byOffice} />
                <SpendTable title={t("costs.spend.byPerson")} lines={costs.data.report.byPerson} />
                <SpendTable title={t("costs.spend.byModel")} lines={costs.data.report.byModel} />
                <SpendTable
                  title={t("costs.spend.byPurpose")}
                  lines={costs.data.report.byPurpose.map((line) => ({
                    ...line,
                    label: t(`costs.purposes.${line.key as "chat"}`, { defaultValue: line.key }),
                  }))}
                />
              </div>
            )}
          </section>
          <BudgetsSection budgets={costs.data.budgets} />
          <PricesSection providers={costs.data.providers} prices={costs.data.prices} />
        </>
      )}
    </>
  );
}

function Summary({
  totalMicros,
  calls,
  unpricedCalls,
}: {
  totalMicros: number;
  calls: number;
  unpricedCalls: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">{t("costs.total")}</p>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(totalMicros)}</p>
      </Card>
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">{t("costs.calls")}</p>
        <p className="text-2xl font-semibold tabular-nums">{formatNumber(calls)}</p>
      </Card>
      <Card className={cn("p-4", unpricedCalls > 0 && "border-warning/60")}>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {unpricedCalls > 0 ? <AlertTriangle className="size-4 text-warning" aria-hidden /> : null}
          {t("costs.unpriced")}
        </p>
        <p className="text-2xl font-semibold tabular-nums">{formatNumber(unpricedCalls)}</p>
        {unpricedCalls > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t("costs.unpricedHint")}</p>
        ) : null}
      </Card>
    </div>
  );
}

function SpendTable({ title, lines }: { title: string; lines: SpendLine[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <caption className="bg-muted/50 px-3 py-2 text-left text-xs font-medium text-muted-foreground">
          {title}
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-1.5 font-medium">
              <span className="sr-only">{title}</span>
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              {t("costs.spend.cost")}
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              {t("costs.calls")}
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              {t("costs.spend.tokens")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => (
            <tr key={line.key}>
              <td className="px-3 py-1.5 break-all">
                {line.label ?? (
                  <span className="text-muted-foreground">{t("costs.spend.gone")}</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                {formatMoney(line.costMicros)}
                {line.unpricedCalls > 0 ? (
                  <span
                    className="ml-1 text-warning"
                    title={t("costs.spend.unpricedCalls", { count: line.unpricedCalls })}
                  >
                    *
                    <span className="sr-only">
                      {t("costs.spend.unpricedCalls", { count: line.unpricedCalls })}
                    </span>
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(line.calls)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                {formatNumber(line.inputTokens + line.outputTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BudgetsSection({ budgets }: { budgets: CostBudget[] }) {
  const { t } = useTranslation();
  const remove = useDeleteBudget();
  return (
    <section aria-labelledby="costs-budgets-title" className="space-y-4">
      <SectionHeader
        id="costs-budgets-title"
        title={t("costs.budgets.title")}
        description={t("costs.budgets.description")}
      />
      {budgets.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("costs.budgets.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {budgets.map((budget) => {
            const ratio = Math.min(1, budget.spentMicros / budget.monthlyLimitMicros);
            const exceeded = budget.spentMicros >= budget.monthlyLimitMicros;
            const warned = ratio * 100 >= budget.warnPercent;
            return (
              <li key={budget.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {budget.scope === "installation"
                        ? t("costs.budgets.scopes.installation")
                        : `${t(`costs.budgets.scopes.${budget.scope}`)}: ${budget.scopeName ?? "—"}`}
                    </p>
                    <div className="flex items-center gap-2 text-sm tabular-nums">
                      <span className={cn(exceeded && "font-semibold text-destructive")}>
                        {formatMoney(budget.spentMicros)} / {formatMoney(budget.monthlyLimitMicros)}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("costs.budgets.remove")}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(budget.id)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(ratio * 100)}
                    aria-label={t("costs.budgets.used")}
                  >
                    <div
                      className={cn(
                        "h-full rounded-full",
                        exceeded ? "bg-destructive" : warned ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {exceeded
                      ? t("costs.budgets.exceeded")
                      : t("costs.budgets.warnAt", { percent: budget.warnPercent })}
                    {budget.unpricedCalls > 0
                      ? ` ${t("costs.budgets.unpricedCalls", { count: budget.unpricedCalls })}`
                      : ""}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {remove.isError ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}
      <BudgetForm />
    </section>
  );
}

function BudgetForm() {
  const { t } = useTranslation();
  const offices = useAdminOffices();
  const people = usePeople();
  const save = useSaveBudget();
  const [scope, setScope] = useState<BudgetScope>("installation");
  const [scopeId, setScopeId] = useState("");
  const [limit, setLimit] = useState("");
  const [warnPercent, setWarnPercent] = useState("80");

  const targets =
    scope === "office"
      ? (offices.data ?? []).map((office) => ({ id: office.id, name: office.name }))
      : scope === "person"
        ? (people.data?.people ?? [])
            .filter((person) => !person.disabled)
            .map((person) => ({ id: person.id, name: person.displayName }))
        : [];

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(
      {
        scope,
        scopeId: scope === "installation" ? null : scopeId,
        monthlyLimit: Number(limit.replace(",", ".")),
        warnPercent: Number(warnPercent),
      },
      {
        onSuccess: () => {
          setLimit("");
        },
      },
    );
  }

  return (
    <Card className="p-4">
      <form
        onSubmit={submit}
        className="grid items-end gap-3 sm:grid-cols-[10rem_1fr_8rem_6rem_auto]"
      >
        <FormField id="budget-scope" label={t("costs.budgets.scope")}>
          <Select
            id="budget-scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as BudgetScope);
              setScopeId("");
            }}
          >
            {(["installation", "office", "person"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`costs.budgets.scopes.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id="budget-target" label={t("costs.budgets.target")}>
          <Select
            id="budget-target"
            value={scopeId}
            disabled={scope === "installation"}
            required={scope !== "installation"}
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="">
              {scope === "installation" ? t("costs.budgets.wholeInstallation") : "—"}
            </option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id="budget-limit" label={t("costs.budgets.limit")}>
          <Input
            id="budget-limit"
            inputMode="decimal"
            required
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            placeholder="50"
          />
        </FormField>
        <FormField id="budget-warn" label={t("costs.budgets.warn")}>
          <Input
            id="budget-warn"
            type="number"
            min={1}
            max={99}
            required
            value={warnPercent}
            onChange={(event) => setWarnPercent(event.target.value)}
          />
        </FormField>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("costs.budgets.save")}
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">{t("costs.budgets.hint")}</p>
      {save.isError ? (
        <div className="mt-2">
          <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Card>
  );
}

function PricesSection({
  providers,
  prices,
}: {
  providers: { id: string; name: string; billing: ProviderBilling }[];
  prices: PriceEntry[];
}) {
  const { t } = useTranslation();
  const setBilling = useSetProviderBilling();
  return (
    <section aria-labelledby="costs-prices-title" className="space-y-4">
      <SectionHeader
        id="costs-prices-title"
        title={t("costs.prices.title")}
        description={t("costs.prices.description")}
      />
      {providers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("costs.prices.noProviders")}
        </p>
      ) : (
        providers.map((provider) => {
          const models = prices.filter((entry) => entry.providerId === provider.id);
          return (
            <Card key={provider.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-medium">{provider.name}</p>
                <div className="w-56">
                  <Select
                    aria-label={t("costs.prices.billing")}
                    value={provider.billing}
                    disabled={setBilling.isPending}
                    onChange={(event) =>
                      setBilling.mutate({
                        id: provider.id,
                        billing: event.target.value as ProviderBilling,
                      })
                    }
                  >
                    <option value="per_token">{t("costs.prices.billings.per_token")}</option>
                    <option value="included">{t("costs.prices.billings.included")}</option>
                  </Select>
                </div>
              </div>
              {provider.billing === "included" ? (
                <p className="text-sm text-muted-foreground">{t("costs.prices.includedHint")}</p>
              ) : models.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("costs.prices.noModels")}</p>
              ) : (
                <ul className="divide-y">
                  {models.map((entry) => (
                    <PriceRow key={entry.model} entry={entry} />
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}
      {setBilling.isError ? <ErrorAlert>{translateError(t, setBilling.error)}</ErrorAlert> : null}
    </section>
  );
}

const RATE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"] as const;

function PriceRow({ entry }: { entry: PriceEntry }) {
  const { t } = useTranslation();
  const save = useSavePrice();
  const initial = (rates: ModelRates | null) =>
    Object.fromEntries(
      RATE_FIELDS.map((field) => [field, rates?.[field] == null ? "" : String(rates[field])]),
    ) as Record<(typeof RATE_FIELDS)[number], string>;
  const [values, setValues] = useState(() => initial(entry.rates));
  const parse = (value: string) => (value.trim() === "" ? null : Number(value.replace(",", ".")));

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({
      providerId: entry.providerId,
      model: entry.model,
      rates: {
        input: parse(values.input) ?? 0,
        cachedInput: parse(values.cachedInput),
        cacheWrite: parse(values.cacheWrite),
        output: parse(values.output) ?? 0,
      },
    });
  }

  return (
    <li className="space-y-2 py-3">
      <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
        {entry.model}
        {entry.rates === null ? (
          <span className="rounded-full border border-warning/60 bg-warning/15 px-2 text-xs font-sans">
            {t("costs.prices.missing")}
          </span>
        ) : null}
        {entry.unpricedCalls > 0 ? (
          <span className="text-xs font-sans text-muted-foreground">
            {t("costs.prices.unpricedCalls", { count: entry.unpricedCalls })}
          </span>
        ) : null}
      </p>
      <form
        onSubmit={submit}
        className="grid items-end gap-2 sm:grid-cols-[repeat(4,1fr)_auto_auto]"
      >
        {RATE_FIELDS.map((field) => (
          <FormField
            key={field}
            id={`${entry.providerId}-${entry.model}-${field}`}
            label={t(`costs.prices.rates.${field}`)}
          >
            <Input
              id={`${entry.providerId}-${entry.model}-${field}`}
              inputMode="decimal"
              required={field === "input" || field === "output"}
              placeholder={
                field === "input" || field === "output" ? "0.00" : t("costs.prices.sameAsInput")
              }
              value={values[field]}
              onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            />
          </FormField>
        ))}
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t("costs.prices.save")}
        </Button>
        {entry.rates ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { providerId: entry.providerId, model: entry.model, rates: null },
                { onSuccess: () => setValues(initial(null)) },
              )
            }
          >
            {t("costs.prices.remove")}
          </Button>
        ) : null}
      </form>
      {save.isError ? <ErrorAlert>{translateError(t, save.error)}</ErrorAlert> : null}
    </li>
  );
}
