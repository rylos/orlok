import { z } from "zod";
import { USER_ROLES } from "../auth";
import { SUPPORTED_LOCALES } from "../i18n";
import { OFFICE_ROLES } from "../offices";
import { emailSchema, passwordSchema, requiredText } from "./fields";
import { issue } from "./issue";

const membershipsSchema = z
  .array(
    z.object({
      officeId: z.uuid(issue("invalid_value")),
      role: z.enum(OFFICE_ROLES).default("member"),
    }),
  )
  .max(500, issue("too_long"))
  .refine(
    (items) => new Set(items.map((item) => item.officeId)).size === items.length,
    issue("invalid_value"),
  );

// Model profiles granted to a person (R-MOD-2).
const profileIdsSchema = z
  .array(z.uuid(issue("invalid_value")))
  .max(200, issue("too_long"))
  .refine((ids) => new Set(ids).size === ids.length, issue("invalid_value"));

// Invitation by email with offices to join and profiles to use (R-ADM-4).
export const invitationCreateSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().max(120, issue("too_long")).nullable().optional(),
  role: z.enum(USER_ROLES).default("member"),
  // Language of the email and of the new account; the installation default when omitted.
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  memberships: membershipsSchema.default([]),
  profileIds: profileIdsSchema.default([]),
});

export const personUpdateSchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  disabled: z.boolean().optional(),
  memberships: membershipsSchema.optional(),
  profileIds: profileIdsSchema.optional(),
});

export const invitationTokenParamSchema = z.object({
  token: z.string().min(20, issue("invalid_value")).max(200, issue("invalid_value")),
});

export const invitationAcceptSchema = z.object({
  displayName: requiredText(120),
  password: passwordSchema,
});

// Choosing a new password from a reset link (R-AUTH-7); the token travels like an invitation's.
export const passwordResetSchema = z.object({
  password: passwordSchema,
});
