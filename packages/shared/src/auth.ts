import type { z } from "zod";
import type { Locale } from "./i18n";
import type { loginSchema, preferencesSchema, setupSchema } from "./schemas/auth";
import type { ThemePreference } from "./theme";

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PASSWORD_MIN_LENGTH = 12;

export type SetupInput = z.input<typeof setupSchema>;
export type LoginInput = z.input<typeof loginSchema>;
export type PreferencesInput = z.input<typeof preferencesSchema>;

export type Me = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  themePreference: ThemePreference;
  locale: Locale;
};

// A signed-in device or browser of the current person (R-AUTH-5).
export type ActiveSession = {
  id: string;
  current: boolean;
  persistent: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type SetupStatus = {
  needsSetup: boolean;
  companyName: string | null;
  defaultLocale: Locale;
  // The image this server runs, as the stack names it, so what is on screen can be told from
  // what was deployed. Null when nothing named it, which is the case outside Docker.
  version: string | null;
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}
