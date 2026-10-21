import type {
  Conversation,
  ConversationListItem,
  ConversationSummary,
  WikiSource,
  WorkspaceOffice,
} from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

export const workspaceKeys = {
  offices: ["workspace", "offices"] as const,
  allConversations: ["workspace", "conversations"] as const,
  conversations: (colleagueId: string) => ["workspace", "conversations", colleagueId] as const,
  conversation: (id: string) => ["workspace", "conversation", id] as const,
};

export function useWorkspaceOffices() {
  return useQuery({
    queryKey: workspaceKeys.offices,
    queryFn: () => apiFetch<WorkspaceOffice[]>("/workspace/offices"),
  });
}

// Each conversation says whether something in it waits for the person's approval. It is not
// asked for again every few seconds: the live events refresh it when an answer starts or ends and
// whenever a request starts or stops waiting, decided here, in another window, on another device
// or on Telegram, so the server does no work while a request just waits.
export function useConversations(colleagueId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: workspaceKeys.conversations(colleagueId),
    queryFn: () =>
      apiFetch<ConversationListItem[]>(
        `/conversations?colleagueId=${encodeURIComponent(colleagueId)}`,
      ),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: workspaceKeys.conversation(id ?? ""),
    queryFn: () => apiFetch<Conversation>(`/conversations/${id}`),
    enabled: Boolean(id),
  });
}

export function useRenameConversation(colleagueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiFetch<ConversationSummary>(`/conversations/${id}`, { method: "PATCH", body: { title } }),
    onSuccess: (summary) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(colleagueId) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversation(summary.id) }),
      ]),
  });
}

export function useDeleteConversation(colleagueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: workspaceKeys.conversation(id) });
      return queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(colleagueId) });
    },
  });
}

// One of the person's own colleagues, archived ones included: their conversations stay readable.
export function findColleague(offices: WorkspaceOffice[] | undefined, colleagueId: string) {
  for (const office of offices ?? []) {
    const active = office.colleagues.find((item) => item.id === colleagueId);
    if (active) {
      return { office, colleague: active, archived: false };
    }
    const archived = office.archived.find((item) => item.id === colleagueId);
    if (archived) {
      return { office, colleague: archived, archived: true };
    }
  }
  return null;
}

// Asks the colleague to file an answer into the office wiki.
export function useSaveAnswerToWiki() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, messageId }: { conversationId: string; messageId: string }) =>
      apiFetch<WikiSource>(`/conversations/${conversationId}/messages/${messageId}/wiki`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wiki"] }),
  });
}

// Saves or lets go what the colleague proposed to keep from a conversation (R-MEM-16).
export function useWikiCandidate(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ index, save }: { index: number; save: boolean }) =>
      apiFetch<WikiSource | null>(`/conversations/${conversationId}/wiki-candidates/${index}`, {
        method: save ? "POST" : "DELETE",
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversation(conversationId) }),
        queryClient.invalidateQueries({ queryKey: ["wiki"] }),
      ]),
  });
}
