import { type RunnerJobRequest, SHELL_KINDS } from "@orlok/shared";
import { z } from "zod";
import { HOST_KEY_PATTERN } from "./ssh";

// NUL bytes cannot be passed to exec and would make spawning throw.
const noNul = (value: string) => !value.includes("\0");
const noControl = (value: string) => !/\p{Cc}/u.test(value);

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

// Host names, IPv4 and IPv6 addresses; never something ssh could read as an option.
const hostSchema = z
  .string()
  .regex(/^(?!-)[A-Za-z0-9._:%-]{1,253}$/)
  .or(
    z
      .string()
      .regex(/^\[[A-Fa-f0-9:.%a-z]+\]$/)
      .transform((host) => host.slice(1, -1)),
  );

const sshAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("password"), password: z.string().min(1).max(4096).refine(noNul) }),
  z.object({
    type: z.literal("key"),
    privateKey: z.string().min(1).max(65_536),
    passphrase: z.string().min(1).max(4096).refine(noNul).optional(),
  }),
]);

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("ssh"),
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(256).refine(noControl),
    auth: sshAuthSchema,
    knownHostKey: z.string().regex(HOST_KEY_PATTERN).nullable(),
    shell: z.enum(SHELL_KINDS),
  }),
  z.object({
    kind: z.literal("winrm"),
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(256).refine(noControl),
    password: z.string().min(1).max(4096).refine(noNul),
    https: z.boolean(),
  }),
]);

export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const jobRequestSchema = z.object({
  id: idSchema,
  target: targetSchema,
  command: z.string().min(1).max(256_000).refine(noNul),
  // Larger values are capped (timeout 3600 s, output 16 MiB), not rejected.
  timeoutSeconds: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  secrets: z.array(z.string().max(65_536)).max(256),
}) satisfies z.ZodType<RunnerJobRequest>;

export const mcpSessionSchema = z.object({
  id: idSchema,
  command: z.string().min(1).max(4096).refine(noNul),
  args: z.array(z.string().max(65_536).refine(noNul)).max(256),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/), z.string().refine(noNul)),
});

export type McpSessionRequest = z.infer<typeof mcpSessionSchema>;

// A single JSON-RPC message; batches (arrays) are not part of current MCP versions.
export const mcpMessageSchema = z.record(z.string(), z.unknown());
