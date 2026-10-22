import type { Me, PasswordResetInput, PasswordResetPreview } from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./queries";
import { clearSignedOut } from "./return-path";
import { clearSessionEnded } from "./session-ended";

// The link an administrator sent to choose a new password (R-AUTH-7).
export function usePasswordResetPreview(token: string) {
  return useQuery({
    queryKey: ["password-reset", token],
    queryFn: () => apiFetch<PasswordResetPreview>(`/password-resets/${encodeURIComponent(token)}`),
    retry: false,
  });
}

export function useCompletePasswordReset(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PasswordResetInput) =>
      apiFetch<Me>(`/password-resets/${encodeURIComponent(token)}`, {
        method: "POST",
        body: input,
      }),
    // Signed in with the new password right away, as after signing in.
    onSuccess: (me) => {
      clearSessionEnded();
      clearSignedOut();
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}
