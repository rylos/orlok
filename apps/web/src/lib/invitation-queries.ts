import type { InvitationAcceptInput, InvitationPreview, Me } from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./queries";

export function useInvitationPreview(token: string) {
  return useQuery({
    queryKey: ["invitation", token],
    queryFn: () => apiFetch<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
}

export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InvitationAcceptInput) =>
      apiFetch<Me>(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: input,
      }),
    // The new account is signed in right away.
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}
