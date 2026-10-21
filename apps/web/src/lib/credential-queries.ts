import type { Credential, CredentialKind, OpsHost } from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

// The signed-in person's own credentials and the host registry they choose from (R-OPS-1,
// R-OPS-3).

export type CredentialInput = {
  name?: string;
  kind?: CredentialKind;
  username?: string | null;
  secret?: string;
  passphrase?: string | null;
  description?: string | null;
  hostIds?: string[];
};

export type HostTestResult = {
  ok: boolean;
  error: string | null;
  output: string;
  hostKey?: string | null;
};

export const credentialKeys = {
  credentials: ["me", "credentials"] as const,
  hosts: ["me", "hosts"] as const,
};

export function useMyCredentials() {
  return useQuery({
    queryKey: credentialKeys.credentials,
    queryFn: () => apiFetch<Credential[]>("/me/credentials"),
  });
}

export function useHostChoices() {
  return useQuery({
    queryKey: credentialKeys.hosts,
    queryFn: () => apiFetch<OpsHost[]>("/me/hosts"),
  });
}

export function useSaveCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: CredentialInput }) =>
      id
        ? apiFetch<Credential>(`/me/credentials/${id}`, { method: "PATCH", body: input })
        : apiFetch<Credential>("/me/credentials", { method: "POST", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: credentialKeys.credentials }),
  });
}

export function useDeleteCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/me/credentials/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: credentialKeys.credentials }),
  });
}

// A successful first test stores the host key; the credential gets a last-used time.
export function useTestCredential(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string) =>
      apiFetch<HostTestResult>(`/me/credentials/${id}/test`, {
        method: "POST",
        body: { hostId },
      }),
    onSettled: () =>
      Promise.all(
        [credentialKeys.credentials, credentialKeys.hosts].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}
