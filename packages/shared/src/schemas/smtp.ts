import { z } from "zod";
import { SMTP_SECURITY } from "../smtp";
import { emailSchema } from "./fields";
import { issue } from "./issue";

// SMTP server used for invitations and notifications (R-ADM-7).
export const smtpSettingsSchema = z.object({
  host: z.string().trim().min(1, issue("required")).max(255, issue("too_long")),
  port: z
    .number(issue("invalid_value"))
    .int(issue("invalid_value"))
    .min(1, issue("invalid_value"))
    .max(65_535, issue("invalid_value")),
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().max(255, issue("too_long")).nullable().optional(),
  // Omitted keeps the saved password, null removes it.
  password: z.string().max(1024, issue("too_long")).nullable().optional(),
  fromAddress: emailSchema,
  fromName: z.string().trim().max(120, issue("too_long")).nullable().optional(),
});

export const smtpTestSchema = z.object({
  to: emailSchema,
});
