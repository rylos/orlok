import { MAX_OUTPUT_TOKENS_LIMIT, PASSWORD_MIN_LENGTH } from "@orlok/shared";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { ApiRequestError } from "@/lib/api";

// Translated general message for a failed API call (R-I18N-4).
export function translateError(t: TFunction, error: unknown) {
  if (error instanceof ApiRequestError) {
    return t(`errors.codes.${error.body.code}`, { defaultValue: error.body.message });
  }
  return t("errors.network");
}

export function formatNumber(value: number) {
  return value.toLocaleString(i18n.resolvedLanguage);
}

// Translated per-field messages (key = field name). Issue params override the defaults.
export function translateFieldErrors(t: TFunction, error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError)) {
    return {};
  }
  return Object.fromEntries(
    (error.body.issues ?? []).map((issue) => [
      issue.path,
      t(`issues.${issue.code}`, {
        min: formatNumber(issue.params?.min ?? PASSWORD_MIN_LENGTH),
        max: formatNumber(issue.params?.max ?? MAX_OUTPUT_TOKENS_LIMIT),
      }),
    ]),
  );
}
