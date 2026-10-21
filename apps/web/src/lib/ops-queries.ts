import type { ApprovalChoice, OpsJob, PlanDecision } from "@orlok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./queries";
import { workspaceKeys } from "./workspace-queries";

// Commands of virtual colleagues seen from the workspace (R-OPS).

const FINISHED = new Set(["done", "failed", "timeout", "stopped", "denied", "expired"]);

export function isJobFinished(job: Pick<OpsJob, "status">) {
  return FINISHED.has(job.status);
}

// Queued or running: its output and its end only show by asking again. A job waiting for a
// decision changes only when someone decides, and the server says so (live events).
export function isJobUnderway(job: Pick<OpsJob, "status">) {
  return job.status === "queued" || job.status === "running";
}

export const opsKeys = {
  all: (officeId: string) => ["ops", officeId] as const,
  jobs: (officeId: string, ids: string[]) => ["ops", officeId, "jobs", ids.join(",")] as const,
  conversation: (officeId: string, conversationId: string) =>
    ["ops", officeId, "conversation", conversationId] as const,
};

// A decision or a stop taken here: the cards and the approval dock follow, and so do the lists of
// conversations, which say which ones wait (the menu and the tabs).
function refreshAfterDecision(queryClient: QueryClient, officeId: string) {
  void queryClient.invalidateQueries({ queryKey: workspaceKeys.allConversations });
  return queryClient.invalidateQueries({ queryKey: opsKeys.all(officeId) });
}

// Polled while some job is queued or running, not while it only waits for a decision.
function refetchWhileActive(jobs: OpsJob[] | undefined) {
  return jobs?.some(isJobUnderway) ? 2_000 : false;
}

export function useOpsJobs(officeId: string, ids: string[]) {
  return useQuery({
    queryKey: opsKeys.jobs(officeId, ids),
    queryFn: () =>
      apiFetch<OpsJob[]>(`/offices/${officeId}/ops/jobs?ids=${encodeURIComponent(ids.join(","))}`),
    enabled: ids.length > 0,
    refetchInterval: (query) => refetchWhileActive(query.state.data),
  });
}

export function useConversationJobs(officeId: string, conversationId: string | undefined) {
  return useQuery({
    queryKey: opsKeys.conversation(officeId, conversationId ?? ""),
    queryFn: () =>
      apiFetch<OpsJob[]>(
        `/offices/${officeId}/ops/jobs?conversationId=${encodeURIComponent(conversationId ?? "")}`,
      ),
    enabled: Boolean(conversationId),
    refetchInterval: (query) => refetchWhileActive(query.state.data),
  });
}

export function useDecideJob(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalChoice }) =>
      apiFetch<OpsJob>(`/offices/${officeId}/ops/jobs/${id}/decision`, {
        method: "POST",
        body: { choice },
      }),
    onSuccess: (_job, { choice }) => {
      void refreshAfterDecision(queryClient, officeId);
      if (choice === "always") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.commandTypes });
      }
    },
  });
}

export function useStopJob(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<OpsJob>(`/offices/${officeId}/ops/jobs/${id}/stop`, { method: "POST" }),
    onSuccess: () => refreshAfterDecision(queryClient, officeId),
  });
}

// Plans (R-OPS-6): the whole plan is approved, denied or stopped at once.
export function useDecidePlan(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: PlanDecision }) =>
      apiFetch<{ id: string; status: string }>(`/offices/${officeId}/ops/plans/${id}/decision`, {
        method: "POST",
        body: { choice },
      }),
    onSuccess: () => refreshAfterDecision(queryClient, officeId),
  });
}

export function useStopPlan(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; status: string }>(`/offices/${officeId}/ops/plans/${id}/stop`, {
        method: "POST",
      }),
    onSuccess: () => refreshAfterDecision(queryClient, officeId),
  });
}
