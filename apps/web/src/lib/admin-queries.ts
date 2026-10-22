import type {
  AdminOffice,
  ApprovedCommandType,
  DocumentSettings,
  EmbeddingOverview,
  EmbeddingSettings,
  EmbeddingTestResult,
  InvitationCreateInput,
  InvitationResult,
  ModelProfile,
  ModelProvider,
  OfficeCreateInput,
  OfficeUpdateInput,
  PasswordResetResult,
  PeopleOverview,
  Person,
  PersonUpdateInput,
  ProfileCreateInput,
  ProfileUpdateInput,
  ProviderCreateInput,
  ProviderModelsResult,
  ProviderUpdateInput,
  SmtpSettings,
  SmtpSettingsInput,
  SmtpTestResult,
  WikiSearchSettings,
} from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { wikiKeys } from "./wiki-queries";
import { workspaceKeys } from "./workspace-queries";

export const adminKeys = {
  providers: ["admin", "providers"] as const,
  providerModels: (id: string) => ["admin", "providers", id, "models"] as const,
  profiles: ["admin", "profiles"] as const,
  offices: ["admin", "offices"] as const,
  people: ["admin", "people"] as const,
  personCommandTypes: (id: string) => ["admin", "people", id, "command-types"] as const,
  smtp: ["admin", "smtp"] as const,
  documents: ["admin", "documents"] as const,
  wikiSearch: ["admin", "wiki-search"] as const,
  embeddings: ["admin", "embeddings"] as const,
};

export function useProviders() {
  return useQuery({
    queryKey: adminKeys.providers,
    queryFn: () => apiFetch<ModelProvider[]>("/admin/providers"),
  });
}

// Model list of a provider; also used as connection test (R-MOD-2).
export function useProviderModels(id: string | null, enabled = true) {
  return useQuery({
    queryKey: adminKeys.providerModels(id ?? ""),
    queryFn: () => apiFetch<ProviderModelsResult>(`/admin/providers/${id}/models`),
    enabled: Boolean(id) && enabled,
    staleTime: 60_000,
    retry: false,
  });
}

type SaveProvider =
  | { id?: undefined; input: ProviderCreateInput }
  | { id: string; input: ProviderUpdateInput };

export function useSaveProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: SaveProvider) =>
      id
        ? apiFetch<ModelProvider>(`/admin/providers/${id}`, { method: "PATCH", body: input })
        : apiFetch<ModelProvider>("/admin/providers", { method: "POST", body: input }),
    onSuccess: (provider) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.providers });
      queryClient.removeQueries({ queryKey: adminKeys.providerModels(provider.id) });
    },
  });
}

export function useDeleteProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.providers }),
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: adminKeys.profiles,
    queryFn: () => apiFetch<ModelProfile[]>("/admin/profiles"),
  });
}

type SaveProfile =
  | { id?: undefined; input: ProfileCreateInput }
  | { id: string; input: ProfileUpdateInput };

export function useSaveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: SaveProfile) =>
      id
        ? apiFetch<ModelProfile>(`/admin/profiles/${id}`, { method: "PATCH", body: input })
        : apiFetch<ModelProfile>("/admin/profiles", { method: "POST", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

export function useAdminOffices() {
  return useQuery({
    queryKey: adminKeys.offices,
    queryFn: () => apiFetch<AdminOffice[]>("/admin/offices"),
  });
}

// Office changes also affect what the workspace shows.
function useInvalidateOffices() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: adminKeys.offices }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.offices }),
    ]);
}

type SaveOffice =
  | { id?: undefined; input: OfficeCreateInput }
  | { id: string; input: OfficeUpdateInput };

export function useSaveOffice() {
  const invalidate = useInvalidateOffices();
  return useMutation({
    mutationFn: (variables: SaveOffice) =>
      variables.id
        ? apiFetch(`/admin/offices/${variables.id}`, { method: "PATCH", body: variables.input })
        : apiFetch("/admin/offices", { method: "POST", body: variables.input }),
    onSuccess: invalidate,
  });
}

export function useDeleteOffice() {
  const invalidate = useInvalidateOffices();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/offices/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

// Empties an office wiki so it can be imported again from scratch.
export function useClearWiki() {
  const invalidate = useInvalidateOffices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (officeId: string) =>
      apiFetch<{ pages: number; sources: number }>(`/admin/offices/${officeId}/wiki`, {
        method: "DELETE",
      }),
    onSuccess: (_, officeId) =>
      Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: wikiKeys.all(officeId) }),
      ]),
  });
}

export function usePeople() {
  return useQuery({
    queryKey: adminKeys.people,
    queryFn: () => apiFetch<PeopleOverview>("/admin/people"),
  });
}

export function useInvitePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InvitationCreateInput) =>
      apiFetch<InvitationResult>("/admin/invitations", { method: "POST", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.people }),
  });
}

export function useResendInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<InvitationResult>(`/admin/invitations/${id}/resend`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.people }),
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.people }),
  });
}

export function useUpdatePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PersonUpdateInput }) =>
      apiFetch<Person>(`/admin/people/${id}`, { method: "PATCH", body: input }),
    // An administrator granting themselves a profile, or taking it away, changes what their own
    // colleagues may use.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: adminKeys.people }),
        queryClient.invalidateQueries({ queryKey: ["colleagues"] }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.offices }),
      ]),
  });
}

// A one-time link for a person to choose a new password; their sessions end at once (R-AUTH-7).
export function useResetPassword() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PasswordResetResult>(`/admin/people/${id}/password-reset`, { method: "POST" }),
  });
}

// The command types a person approved "always" (R-OPS-4), loaded when an administrator opens them.
export function usePersonCommandTypes(personId: string, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.personCommandTypes(personId),
    queryFn: () => apiFetch<ApprovedCommandType[]>(`/admin/people/${personId}/command-types`),
    enabled,
  });
}

// An administrator turning a type off stays so until an administrator turns it on again.
export function useSetPersonCommandTypeDisabled(personId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      apiFetch<ApprovedCommandType>(`/admin/people/${personId}/command-types/${id}`, {
        method: "PATCH",
        body: { disabled },
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: adminKeys.personCommandTypes(personId) }),
  });
}

export function useSmtpSettings() {
  return useQuery({
    queryKey: adminKeys.smtp,
    queryFn: () => apiFetch<SmtpSettings | null>("/admin/smtp"),
  });
}

export function useSaveSmtp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SmtpSettingsInput) =>
      apiFetch<SmtpSettings>("/admin/smtp", { method: "PUT", body: input }),
    onSuccess: (settings) => queryClient.setQueryData(adminKeys.smtp, settings),
  });
}

export function useTestSmtp() {
  return useMutation({
    mutationFn: (to: string) =>
      apiFetch<SmtpTestResult>("/admin/smtp/test", { method: "POST", body: { to } }),
  });
}

export function useDocumentSettings() {
  return useQuery({
    queryKey: adminKeys.documents,
    queryFn: () => apiFetch<DocumentSettings>("/admin/documents"),
  });
}

export function useSaveDocumentSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DocumentSettings) =>
      apiFetch<DocumentSettings>("/admin/documents", { method: "PUT", body: input }),
    onSuccess: (data) => queryClient.setQueryData(adminKeys.documents, data),
  });
}

export function useWikiSearchSettings() {
  return useQuery({
    queryKey: adminKeys.wikiSearch,
    queryFn: () => apiFetch<WikiSearchSettings>("/admin/wiki-search"),
  });
}

export function useSaveWikiSearchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WikiSearchSettings) =>
      apiFetch<WikiSearchSettings>("/admin/wiki-search", { method: "PUT", body: input }),
    onSuccess: (data) => queryClient.setQueryData(adminKeys.wikiSearch, data),
  });
}

// Refreshed while pages are still being indexed.
export function useEmbeddingSettings() {
  return useQuery({
    queryKey: adminKeys.embeddings,
    queryFn: () => apiFetch<EmbeddingOverview>("/admin/embeddings"),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.mode !== "off" && data.indexedPages < data.totalPages ? 10_000 : false;
    },
  });
}

export function useSaveEmbeddingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EmbeddingSettings) =>
      apiFetch<EmbeddingOverview>("/admin/embeddings", { method: "PUT", body: input }),
    onSuccess: (data) => queryClient.setQueryData(adminKeys.embeddings, data),
  });
}

export function useTestEmbeddings() {
  return useMutation({
    mutationFn: (input: EmbeddingSettings) =>
      apiFetch<EmbeddingTestResult>("/admin/embeddings/test", { method: "POST", body: input }),
  });
}
