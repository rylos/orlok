// Supported languages (R-I18N-1). English is the reference language and the fallback.
export const SUPPORTED_LOCALES = ["en", "it"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Each language's name written in that language, as shown in selectors.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  it: "Italiano",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// First supported language among the browser preferences (e.g. ["it-IT", "en-US"] → "it").
export function matchLocale(candidates: readonly string[]): Locale | null {
  for (const candidate of candidates) {
    const primary = candidate.toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) {
      return primary;
    }
  }
  return null;
}
