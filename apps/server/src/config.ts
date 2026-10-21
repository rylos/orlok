import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, { error: "DATABASE_URL is required" }),
  // Address people use to open Orlok; used in links sent by email.
  ORLOK_PUBLIC_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:5173"),
  // Internal runner service that executes colleague commands (R-OPS). Both or neither.
  ORLOK_RUNNER_URL: z.url({ protocol: /^https?$/ }).optional(),
  ORLOK_RUNNER_TOKEN: z.string().min(16).optional(),
  // Built web app (apps/web/dist) served for every non-API path; unset in development (Vite).
  ORLOK_WEB_DIR: z.string().trim().min(1).optional(),
  // The image tag the stack runs, passed in by compose: shown in the app so a deploy can be
  // recognised at a glance. Docker tells a container nothing about its own tag.
  ORLOK_IMAGE: z.string().trim().min(1).optional(),
  ORLOK_SECRET_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    error: "ORLOK_SECRET_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)",
  }),
});

export type Config = {
  env: "development" | "production" | "test";
  port: number;
  databaseUrl: string;
  // In production cookies are sent over HTTPS only.
  secureCookies: boolean;
  // Encrypts provider keys and credentials at rest (R-SEC-2). Never stored in the database.
  secretKey: Buffer;
  // Without trailing slash.
  publicUrl: string;
  runner: { url: string; token: string } | null;
  // Absolute directory of the built web app, or null when the server only answers the API.
  webDir: string | null;
  // Image reference of this server (e.g. `orlok:2026.10.05`), or null when unknown.
  image: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    // Secure cookies only over https: Orlok is often opened over plain http on a LAN address,
    // where browsers would drop them and nobody could sign in.
    secureCookies: parsed.ORLOK_PUBLIC_URL.startsWith("https://"),
    secretKey: Buffer.from(parsed.ORLOK_SECRET_KEY, "base64"),
    publicUrl: parsed.ORLOK_PUBLIC_URL.replace(/\/+$/, ""),
    runner:
      parsed.ORLOK_RUNNER_URL && parsed.ORLOK_RUNNER_TOKEN
        ? { url: parsed.ORLOK_RUNNER_URL.replace(/\/+$/, ""), token: parsed.ORLOK_RUNNER_TOKEN }
        : null,
    webDir: parsed.ORLOK_WEB_DIR ? path.resolve(parsed.ORLOK_WEB_DIR) : null,
    image: parsed.ORLOK_IMAGE ?? null,
  };
}
