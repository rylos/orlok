import { type ThemePreference, themesByMode } from "@orlok/shared";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/select";
import { useChooseTheme } from "@/lib/queries";
import { useTheme } from "./ThemeProvider";

// One dropdown with every theme, grouped by light and dark (R-UI-2, R-UI-3). Theme names are the
// ones their projects go by, so they are not translated.
export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { preference } = useTheme();
  const chooseTheme = useChooseTheme();

  return (
    // As wide as its longest name, whichever theme is chosen: a fixed width cut "Catppuccin Mocha".
    <Select
      aria-label={t("theme.label")}
      className="w-auto"
      value={preference}
      onChange={(event) => chooseTheme(event.target.value as ThemePreference)}
    >
      <option value="system">{t("theme.system")}</option>
      <optgroup label={t("theme.light")}>
        {themesByMode("light").map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("theme.dark")}>
        {themesByMode("dark").map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}
