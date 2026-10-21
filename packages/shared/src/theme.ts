// UI themes (R-UI-2). Ids match the data-theme attribute used by the CSS. Palettes come from the
// original projects, as packaged by Omarchy; the names are theirs.
export const THEMES = [
  { id: "latte", label: "Catppuccin Latte", mode: "light" },
  { id: "rose-pine", label: "Rosé Pine Dawn", mode: "light" },
  { id: "tokyo-night-light", label: "Tokyo Night Light", mode: "light" },
  { id: "mocha", label: "Catppuccin Mocha", mode: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", mode: "dark" },
  { id: "nord", label: "Nord", mode: "dark" },
  { id: "gruvbox", label: "Gruvbox", mode: "dark" },
  { id: "everforest", label: "Everforest", mode: "dark" },
  { id: "kanagawa", label: "Kanagawa", mode: "dark" },
  { id: "matte-black", label: "Matte Black", mode: "dark" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const THEME_PREFERENCES = [
  "system",
  "latte",
  "rose-pine",
  "tokyo-night-light",
  "mocha",
  "tokyo-night",
  "nord",
  "gruvbox",
  "everforest",
  "kanagawa",
  "matte-black",
] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

// What "follow the system" resolves to. Both belong to the same family, so switching between day
// and night keeps the interface recognizable.
export const DEFAULT_LIGHT_THEME: ThemeId = "latte";
export const DEFAULT_DARK_THEME: ThemeId = "mocha";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeId {
  if (preference === "system") {
    return prefersDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
  }
  return preference;
}

export function themeMode(theme: ThemeId): "light" | "dark" {
  return THEMES.find((t) => t.id === theme)?.mode ?? "light";
}

export function themesByMode(mode: "light" | "dark") {
  return THEMES.filter((theme) => theme.mode === mode);
}
