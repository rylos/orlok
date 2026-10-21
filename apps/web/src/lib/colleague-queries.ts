import type {
  Colleague,
  ColleagueCreateInput,
  ColleagueUpdateInput,
  ModelProfile,
  WikiColleagueRef,
} from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch } from "./api";
import { workspaceKeys } from "./workspace-queries";

// The signed-in person's own colleagues (R-ADM-3) and the profiles they may give them (R-MOD-2).

export const colleagueKeys = {
  all: ["colleagues"] as const,
  profiles: ["colleagues", "profiles"] as const,
  detail: (id: string) => ["colleagues", "detail", id] as const,
};

export function useMyProfiles() {
  return useQuery({
    queryKey: colleagueKeys.profiles,
    queryFn: () => apiFetch<ModelProfile[]>("/colleagues/profiles"),
  });
}

export function useColleague(id: string) {
  return useQuery({
    queryKey: colleagueKeys.detail(id),
    queryFn: () => apiFetch<Colleague>(`/colleagues/${id}`),
    enabled: Boolean(id),
  });
}

// A colleague's changes show in the side list too.
function useInvalidateColleagues() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: colleagueKeys.all }),
      queryClient.invalidateQueries({ queryKey: workspaceKeys.offices }),
    ]);
}

type SaveColleague =
  | { id?: undefined; input: ColleagueCreateInput }
  | { id: string; input: ColleagueUpdateInput };

export function useSaveColleague() {
  const invalidate = useInvalidateColleagues();
  return useMutation({
    mutationFn: (variables: SaveColleague) =>
      variables.id
        ? apiFetch<Colleague>(`/colleagues/${variables.id}`, {
            method: "PATCH",
            body: variables.input,
          })
        : apiFetch<Colleague>("/colleagues", { method: "POST", body: variables.input }),
    onSuccess: invalidate,
  });
}

export function useArchiveColleague() {
  const invalidate = useInvalidateColleagues();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiFetch<Colleague>(`/colleagues/${id}`, { method: "PATCH", body: { archived } }),
    onSuccess: invalidate,
  });
}

// Deleting takes the colleague's conversations with it.
export function useDeleteColleague() {
  const invalidate = useInvalidateColleagues();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/colleagues/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: workspaceKeys.conversations(id) });
      return invalidate();
    },
  });
}

// A colleague named in the wiki or the audit log, with its owner: two people's colleagues can share
// a name. A deleted one says so.
export function useColleagueRefName() {
  const { t } = useTranslation();
  return (ref: WikiColleagueRef) => {
    const name = ref.owner ? t("colleagues.ref", { name: ref.name, owner: ref.owner }) : ref.name;
    return ref.deleted ? t("colleagues.refDeleted", { name }) : name;
  };
}
