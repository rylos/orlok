import type { TFunction } from "i18next";
import i18n from "@/i18n";

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const KNOWN_TEST_ERRORS = [
  "runner_not_configured",
  "credential_missing",
  "host_key_mismatch",
  "auth_failed",
  "unreachable",
  "credential_unsupported",
  "certificate_invalid",
  "winrm_error",
] as const;

// Connection test failures: machine codes are translated, anything else is shown as is.
export function translateTestError(t: TFunction, error: string | null) {
  if (!error) {
    return t("ops.hosts.testErrors.unknown");
  }
  return (KNOWN_TEST_ERRORS as readonly string[]).includes(error)
    ? t(`ops.hosts.testErrors.${error as (typeof KNOWN_TEST_ERRORS)[number]}`)
    : error;
}

// "ssh-ed25519 AAAA…" → "ssh-ed25519".
export function hostKeyType(hostKey: string) {
  return hostKey.split(" ")[0] ?? hostKey;
}
