import { isLocale, LOCALE_NAMES, SUPPORTED_LOCALES } from "@orlok/shared";
import { ChevronDown, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChooseLocale } from "@/lib/queries";
import { currentLocale } from ".";

export function LocaleSwitcher() {
  const { t } = useTranslation();
  const chooseLocale = useChooseLocale();

  return (
    <label className="relative inline-flex h-9 items-center rounded-lg border bg-card pl-2.5 text-sm focus-within:outline-2 focus-within:outline-ring">
      <Languages className="size-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">{t("locale.label")}</span>
      <select
        value={currentLocale()}
        onChange={(event) => {
          if (isLocale(event.target.value)) {
            chooseLocale(event.target.value);
          }
        }}
        className="h-full cursor-pointer appearance-none bg-transparent pr-7 pl-2 outline-none"
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale} className="bg-popover">
            {LOCALE_NAMES[locale]}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground"
        aria-hidden
      />
    </label>
  );
}
