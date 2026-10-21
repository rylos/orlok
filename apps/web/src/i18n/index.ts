import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  matchLocale,
  SUPPORTED_LOCALES,
} from "@orlok/shared";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { it } from "./locales/it";

// Same key read by the inline script in index.html.
const STORAGE_KEY = "orlok-locale";

function storedLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

// True when the user picked a language or the browser prefers a supported one.
export function hasPreferredLocale() {
  return storedLocale() !== null || matchLocale(navigator.languages) !== null;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
  },
  lng: storedLocale() ?? matchLocale(navigator.languages) ?? DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  interpolation: { escapeValue: false },
});

document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

export function currentLocale(): Locale {
  return isLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LOCALE;
}

// Switches language and remembers it on this device (R-I18N-2).
export function setLocale(locale: Locale) {
  void i18n.changeLanguage(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

export default i18n;
