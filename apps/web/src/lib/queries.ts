import type {
  ActiveSession,
  ApprovedCommandType,
  Locale,
  LoginInput,
  Me,
  NotificationSettings,
  PreferencesInput,
  SetupInput,
  SetupStatus,
  ThemePreference,
} from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { setLocale } from "@/i18n";
import { useTheme } from "@/theme/ThemeProvider";
import { ApiRequestError, apiFetch } from "./api";
import { clearSignedOut, markSignedOut } from "./return-path";
import { clearSessionEnded } from "./session-ended";

export const queryKeys = {
  me: ["me"] as const,
  sessions: ["me", "sessions"] as const,
  notifications: ["me", "notifications"] as const,
  commandTypes: ["me", "command-types"] as const,
  setupStatus: ["setup-status"] as const,
};

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: () => apiFetch<SetupStatus>("/setup/status"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// Current user, or null when there is no valid session.
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return await apiFetch<Me>("/me");
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          return null;
        }
        throw error;
      }
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => apiFetch<Me>("/setup", { method: "POST", body: input }),
    onSuccess: (me, input) => {
      queryClient.setQueryData<SetupStatus>(queryKeys.setupStatus, (current) => ({
        needsSetup: false,
        companyName: input.companyName.trim(),
        defaultLocale: me.locale,
        version: current?.version ?? null,
      }));
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => apiFetch<Me>("/auth/login", { method: "POST", body: input }),
    onSuccess: (me) => {
      clearSessionEnded();
      clearSignedOut();
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/auth/logout", { method: "POST" }),
    onMutate: markSignedOut,
    onSettled: () => queryClient.setQueryData(queryKeys.me, null),
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PreferencesInput) =>
      apiFetch<Me>("/me/preferences", { method: "PATCH", body: input }),
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}

// Applies the theme locally right away and, when signed in, saves it to the profile (R-UI-3).
export function useChooseTheme() {
  const { setPreference } = useTheme();
  const { data: me } = useMe();
  const { mutate } = useUpdatePreferences();

  return useCallback(
    (preference: ThemePreference) => {
      setPreference(preference);
      if (me && me.themePreference !== preference) {
        mutate({ themePreference: preference });
      }
    },
    [me, mutate, setPreference],
  );
}

// Applies the language right away and, when signed in, saves it to the profile (R-I18N-2).
export function useChooseLocale() {
  const { data: me } = useMe();
  const { mutate } = useUpdatePreferences();

  return useCallback(
    (locale: Locale) => {
      setLocale(locale);
      if (me && me.locale !== locale) {
        mutate({ locale });
      }
    },
    [me, mutate],
  );
}

// Devices and browsers signed in as the current person (R-AUTH-5).
export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => apiFetch<ActiveSession[]>("/me/sessions"),
  });
}

// Command types the person approved "always": they spare only that person, with every colleague.
export function useCommandTypes() {
  return useQuery({
    queryKey: queryKeys.commandTypes,
    queryFn: () => apiFetch<ApprovedCommandType[]>("/me/command-types"),
  });
}

export function useSetCommandTypeDisabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      apiFetch<ApprovedCommandType>(`/me/command-types/${id}`, {
        method: "PATCH",
        body: { disabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.commandTypes }),
  });
}

export function useDeleteCommandType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/me/command-types/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.commandTypes }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (session: ActiveSession) =>
      apiFetch<void>(`/me/sessions/${session.id}`, { method: "DELETE" }),
    onSuccess: (_result, session) => {
      if (session.current) {
        queryClient.setQueryData(queryKeys.me, null);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/me/sessions", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

// Notifications about approvals and finished interventions (R-CHAT-7).
export function useNotificationSettings() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => apiFetch<NotificationSettings>("/me/notifications"),
  });
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email?: boolean; push?: boolean; telegram?: boolean }) =>
      apiFetch<NotificationSettings>("/me/notifications", { method: "PATCH", body: input }),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.notifications, settings),
  });
}

// Changing one's own password (R-AUTH-6); other devices are signed out.
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      apiFetch<void>("/me/password", { method: "PATCH", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}
