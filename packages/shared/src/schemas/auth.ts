import { z } from "zod";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../i18n";
import { THEME_PREFERENCES } from "../theme";
import { emailSchema, passwordSchema, requiredText } from "./fields";
import { issue } from "./issue";

// First-run installation setup (R-ADM-1, R-I18N-3).
export const setupSchema = z.object({
  companyName: requiredText(120),
  displayName: requiredText(120),
  email: emailSchema,
  password: passwordSchema,
  locale: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
});

// Changing one's own password (R-AUTH-6): the current one confirms it is really you.
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, issue("required")).max(256, issue("too_long")),
  newPassword: passwordSchema,
});

// Sign-in with an optional persistent session (R-AUTH-1).
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, issue("required")).max(256, issue("too_long")),
  remember: z.boolean().default(false),
});

// User preferences stored in the profile (R-UI-3, R-I18N-2); at least one field.
export const preferencesSchema = z
  .object({
    themePreference: z.enum(THEME_PREFERENCES).optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .refine(
    (value) => value.themePreference !== undefined || value.locale !== undefined,
    issue("required"),
  );
