import {
  isLocale,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  THEMES,
  type ThemePreference,
  themesByMode,
} from "@orlok/shared";
import {
  ChevronLeft,
  ChevronRight,
  Languages,
  LogOut,
  Palette,
  Settings,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { currentLocale } from "@/i18n";
import { useChooseLocale, useChooseTheme, useLogout, useMe } from "@/lib/queries";
import { useTheme } from "@/theme/ThemeProvider";

// "Alex Morgan" → "AM"; one word gives its first letter, no name the email's.
function initials(name: string, email: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (`${first}${last}` || email[0] || "?").toUpperCase();
}

type View = "main" | "language" | "theme";

// The person's own menu, a circle with their initials: account, language, theme, administration
// and signing out. Language and theme open their list in place of the menu, with a way back, so
// they work the same with a mouse, the keyboard and a finger.
export function AccountMenu({ side = "bottom" }: { side?: "bottom" | "top" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const logout = useLogout();
  const { preference } = useTheme();
  const chooseTheme = useChooseTheme();
  const chooseLocale = useChooseLocale();
  const [view, setView] = useState<View>("main");

  if (!me) {
    return null;
  }
  const locale = currentLocale();
  const themeName =
    preference === "system"
      ? t("theme.system")
      : (THEMES.find((theme) => theme.id === preference)?.label ?? preference);

  return (
    <Menu
      label={t("nav.accountMenu", { name: me.displayName })}
      side={side}
      align={side === "top" ? "start" : "end"}
      className="w-64"
      view={view}
      onClosed={() => setView("main")}
      buttonClassName="grid size-9 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary hover:bg-primary/25"
      button={initials(me.displayName, me.email)}
    >
      {(close) => {
        const back = (
          <MenuItem icon={<ChevronLeft aria-hidden />} onClick={() => setView("main")}>
            {t("common.back")}
          </MenuItem>
        );
        const done = close;
        if (view === "language") {
          return (
            <>
              {back}
              <MenuSeparator />
              {SUPPORTED_LOCALES.map((item) => (
                <MenuItem
                  key={item}
                  lang={item}
                  checked={item === locale}
                  onClick={() => {
                    if (isLocale(item)) {
                      chooseLocale(item);
                    }
                    done();
                  }}
                >
                  {LOCALE_NAMES[item]}
                </MenuItem>
              ))}
            </>
          );
        }
        if (view === "theme") {
          const option = (id: ThemePreference, label: string) => (
            <MenuItem
              key={id}
              checked={id === preference}
              onClick={() => {
                chooseTheme(id);
                done();
              }}
            >
              {label}
            </MenuItem>
          );
          return (
            <div className="max-h-[70vh] overflow-y-auto">
              {back}
              <MenuSeparator />
              {option("system", t("theme.system"))}
              <MenuLabel>{t("theme.light")}</MenuLabel>
              {themesByMode("light").map((theme) => option(theme.id, theme.label))}
              <MenuLabel>{t("theme.dark")}</MenuLabel>
              {themesByMode("dark").map((theme) => option(theme.id, theme.label))}
            </div>
          );
        }
        return (
          <>
            <div className="px-2 py-1.5">
              <p className="truncate font-medium">{me.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">{t(`roles.${me.role}`)}</p>
            </div>
            <MenuSeparator />
            <MenuItem
              icon={<UserRound aria-hidden />}
              onClick={() => {
                done();
                navigate("/account");
              }}
            >
              {t("nav.account")}
            </MenuItem>
            <MenuItem
              icon={<Languages aria-hidden />}
              end={
                <>
                  {LOCALE_NAMES[locale]}
                  <ChevronRight aria-hidden />
                </>
              }
              onClick={() => setView("language")}
            >
              {t("locale.label")}
            </MenuItem>
            <MenuItem
              icon={<Palette aria-hidden />}
              end={
                <>
                  <span className="max-w-28 truncate">{themeName}</span>
                  <ChevronRight aria-hidden />
                </>
              }
              onClick={() => setView("theme")}
            >
              {t("theme.label")}
            </MenuItem>
            {me.role === "admin" ? (
              <MenuItem
                icon={<Settings aria-hidden />}
                onClick={() => {
                  done();
                  navigate("/admin");
                }}
              >
                {t("nav.administration")}
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              icon={<LogOut aria-hidden />}
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t("auth.signOut")}
            </MenuItem>
          </>
        );
      }}
    </Menu>
  );
}
