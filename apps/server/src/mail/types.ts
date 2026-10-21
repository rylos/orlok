import type { SmtpSecurity } from "@orlok/shared";

export type SmtpConnection = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
};

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

// Injected so tests can capture emails instead of sending them.
export type MailerFactory = (connection: SmtpConnection) => Mailer;
