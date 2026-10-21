import type { z } from "zod";
import type { smtpSettingsSchema, smtpTestSchema } from "./schemas/smtp";

// SMTP settings (R-ADM-7). The password never leaves the server.
export const SMTP_SECURITY = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export function isSmtpSecurity(value: unknown): value is SmtpSecurity {
  return typeof value === "string" && (SMTP_SECURITY as readonly string[]).includes(value);
}

export type SmtpSettingsInput = z.input<typeof smtpSettingsSchema>;
export type SmtpTestInput = z.input<typeof smtpTestSchema>;

export type SmtpSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
};

export type SmtpTestResult = { ok: true } | { ok: false; message: string };
