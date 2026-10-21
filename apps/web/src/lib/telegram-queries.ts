import type { TelegramBotSettings, TelegramLink } from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

// Telegram (R-CHAT-10): the installation's bot, and each person's link to it.

const keys = {
  bot: ["admin", "telegram"] as const,
  link: ["me", "telegram"] as const,
};

export function useTelegramBot() {
  return useQuery({
    queryKey: keys.bot,
    queryFn: () => apiFetch<TelegramBotSettings>("/admin/telegram"),
  });
}

export function useSaveTelegramBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<TelegramBotSettings>("/admin/telegram", { method: "PUT", body: { token } }),
    onSuccess: (data) => queryClient.setQueryData(keys.bot, data),
  });
}

export function useRemoveTelegramBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/admin/telegram", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.bot }),
  });
}

export function useTelegramLink() {
  return useQuery({
    queryKey: keys.link,
    queryFn: () => apiFetch<TelegramLink>("/me/telegram"),
    // Linking happens in Telegram: look again while the page is open.
    refetchInterval: 10_000,
  });
}

export function useCreateTelegramLink() {
  return useMutation({
    mutationFn: () => apiFetch<{ url: string }>("/me/telegram/link", { method: "POST" }),
  });
}

export function useUnlinkTelegram() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/me/telegram", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.link }),
  });
}
