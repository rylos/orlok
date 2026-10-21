import type { BudgetInput, CostOverview, ModelPriceInput, ProviderBilling } from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

// Spend, prices and monthly limits (R-MOD-4), administrators only.

export const costKeys = {
  all: ["admin", "costs"] as const,
  month: (month: string) => ["admin", "costs", month] as const,
};

export function useCosts(month: string) {
  return useQuery({
    queryKey: costKeys.month(month),
    queryFn: () => apiFetch<CostOverview>(`/admin/costs?month=${month}`),
  });
}

function useInvalidateCosts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: costKeys.all });
}

export function useSetProviderBilling() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: ({ id, billing }: { id: string; billing: ProviderBilling }) =>
      apiFetch<void>(`/admin/costs/providers/${id}`, { method: "PUT", body: { billing } }),
    onSuccess: invalidate,
  });
}

export function useSavePrice() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: (input: ModelPriceInput) =>
      apiFetch<void>("/admin/costs/prices", { method: "PUT", body: input }),
    onSuccess: invalidate,
  });
}

export function useSaveBudget() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: (input: BudgetInput) =>
      apiFetch<void>("/admin/costs/budgets", { method: "PUT", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteBudget() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/costs/budgets/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}
