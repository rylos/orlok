import {
  isThemePreference,
  resolveTheme,
  type ThemeId,
  type ThemePreference,
  themeMode,
} from "@orlok/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// Same key read by the inline script in index.html.
const STORAGE_KEY = "orlok-theme";

function readStoredPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function darkQuery() {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", themeMode(theme) === "dark");
}

type ThemeContextValue = {
  preference: ThemePreference;
  theme: ThemeId;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readStoredPreference);
  const [prefersDark, setPrefersDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const query = darkQuery();
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme = resolveTheme(preference, prefersDark);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable (e.g. private browsing): the choice lasts for this session only.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, theme, setPreference }),
    [preference, theme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
