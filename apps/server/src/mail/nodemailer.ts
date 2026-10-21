import nodemailer from "nodemailer";
import type { MailerFactory } from "./types";

export const createMailer: MailerFactory = (connection) => {
  const transport = nodemailer.createTransport({
    host: connection.host,
    port: connection.port,
    secure: connection.security === "tls",
    requireTLS: connection.security === "starttls",
    ignoreTLS: connection.security === "none",
    auth: connection.username
      ? { user: connection.username, pass: connection.password ?? "" }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    async send(message) {
      await transport.sendMail({
        from: connection.fromName
          ? { name: connection.fromName, address: connection.fromAddress }
          : connection.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
};
