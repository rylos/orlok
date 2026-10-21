import { z } from "zod";
import {
  APPROVAL_CHOICES,
  CREDENTIAL_KINDS,
  HOST_CONNECTIONS,
  HOST_KINDS,
  MCP_TOOL_POLICIES,
  MCP_TRANSPORTS,
  PLAN_DECISIONS,
} from "../ops";
import { requiredText } from "./fields";
import { issue } from "./issue";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, issue("too_long"))
    .transform((value) => value || null)
    .nullable();

// Host names, IPv4 and IPv6 addresses.
const addressSchema = z
  .string()
  .trim()
  .min(1, issue("required"))
  .max(255, issue("too_long"))
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$|^[0-9a-fA-F:.]+$/,
    issue("invalid_value"),
  );

// Hosts a credential is used on.
const hostIdsSchema = z
  .array(z.uuid(issue("invalid_value")))
  .max(500, issue("too_long"))
  .refine((ids) => new Set(ids).size === ids.length, issue("invalid_value"));

export const credentialCreateSchema = z.object({
  name: requiredText(80),
  kind: z.enum(CREDENTIAL_KINDS, issue("invalid_value")),
  username: optionalText(200).default(null),
  secret: z.string().min(1, issue("required")).max(20_000, issue("too_long")),
  passphrase: z.string().max(1_000, issue("too_long")).nullable().default(null),
  description: optionalText(500).default(null),
  hostIds: hostIdsSchema.default([]),
});

// The secret is replaced only when given.
export const credentialUpdateSchema = z.object({
  name: requiredText(80).optional(),
  username: optionalText(200).optional(),
  secret: z.string().min(1, issue("required")).max(20_000, issue("too_long")).optional(),
  passphrase: z.string().max(1_000, issue("too_long")).nullable().optional(),
  description: optionalText(500).optional(),
  hostIds: hostIdsSchema.optional(),
});

// The fields of a host without defaults: an update changes only what it names. Defaults belong
// to creation alone; on an update they would reset the port, tags and description of any host
// whose update leaves them out, such as forgetting its host key.
const hostFields = {
  name: requiredText(80),
  kind: z.enum(HOST_KINDS, issue("invalid_value")),
  connection: z.enum(HOST_CONNECTIONS, issue("invalid_value")),
  address: addressSchema,
  port: z
    .int(issue("invalid_value"))
    .min(1, issue("invalid_value"))
    .max(65_535, issue("invalid_value")),
  tags: z
    .array(z.string().trim().min(1, issue("required")).max(40, issue("too_long")))
    .max(20, issue("too_long")),
  description: optionalText(500),
  enabled: z.boolean(),
};

// WinRM reaches Windows only.
const winrmOnWindows = (value: { kind?: string; connection?: string }, ctx: z.RefinementCtx) => {
  if (value.connection && value.connection !== "ssh" && value.kind && value.kind !== "windows") {
    ctx.addIssue({ code: "custom", path: ["connection"], message: "invalid_value" });
  }
};

export const hostCreateSchema = z
  .object({
    ...hostFields,
    connection: hostFields.connection.default("ssh"),
    port: hostFields.port.default(22),
    tags: hostFields.tags.default([]),
    description: hostFields.description.default(null),
    enabled: hostFields.enabled.default(true),
  })
  .superRefine(winrmOnWindows);

export const hostUpdateSchema = z
  .object(hostFields)
  .partial()
  .extend({
    // Forget the trusted host key, e.g. after reinstalling the server.
    resetHostKey: z.boolean().optional(),
  })
  .superRefine(winrmOnWindows);

export const planDecisionSchema = z.object({
  choice: z.enum(PLAN_DECISIONS, issue("invalid_value")),
});

export const approvalSchema = z.object({
  choice: z.enum(APPROVAL_CHOICES, issue("invalid_value")),
});

// Turning an approved command type off or on again.
export const commandTypeUpdateSchema = z.object({
  disabled: z.boolean(),
});

// Which of its hosts a credential is tried on.
export const credentialTestSchema = z.object({
  hostId: z.uuid(issue("invalid_value")),
});

export const officeIdParamSchema = z.object({ officeId: z.uuid(issue("invalid_value")) });

export const officeItemParamSchema = z.object({
  officeId: z.uuid(issue("invalid_value")),
  id: z.uuid(issue("invalid_value")),
});

const mcpSecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, issue("invalid_value"));
// Tools colleagues are given (null: all of them). Names as the server gives them.
const mcpAllowedTools = z
  .array(z.string().trim().min(1, issue("required")).max(200, issue("too_long")))
  .max(1_000, issue("too_long"))
  .nullable();

export const mcpServerCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, issue("invalid_value")),
    description: optionalText(500).default(null),
    transport: z.enum(MCP_TRANSPORTS, issue("invalid_value")),
    url: z
      .url({ protocol: /^https?$/, error: "invalid_url" })
      .nullable()
      .default(null),
    command: z.string().trim().max(300, issue("too_long")).nullable().default(null),
    args: z
      .array(z.string().max(1_000, issue("too_long")))
      .max(50, issue("too_long"))
      .default([]),
    // Header values (http) or environment variables (stdio), stored encrypted.
    secrets: z.record(mcpSecretName, z.string().max(8_000, issue("too_long"))).default({}),
    toolPolicy: z.enum(MCP_TOOL_POLICIES, issue("invalid_value")).default("readonly_auto"),
    enabled: z.boolean().default(true),
    allowedTools: mcpAllowedTools.default(null),
  })
  .superRefine((value, context) => {
    if (value.transport === "http" && !value.url) {
      context.addIssue({ code: "custom", path: ["url"], message: "required" });
    }
    if (value.transport === "stdio" && !value.command) {
      context.addIssue({ code: "custom", path: ["command"], message: "required" });
    }
  });

// Secrets: a value replaces it, null removes it, an omitted name keeps it.
export const mcpServerUpdateSchema = z.object({
  description: optionalText(500).optional(),
  url: z
    .url({ protocol: /^https?$/, error: "invalid_url" })
    .nullable()
    .optional(),
  command: z.string().trim().max(300, issue("too_long")).nullable().optional(),
  args: z
    .array(z.string().max(1_000, issue("too_long")))
    .max(50, issue("too_long"))
    .optional(),
  secrets: z.record(mcpSecretName, z.string().max(8_000, issue("too_long")).nullable()).optional(),
  toolPolicy: z.enum(MCP_TOOL_POLICIES, issue("invalid_value")).optional(),
  enabled: z.boolean().optional(),
  allowedTools: mcpAllowedTools.optional(),
});

// Audit export (R-SEC-5): a format and an optional range of days, both ends included.
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, issue("invalid_value"));
export const auditExportSchema = z.object({
  format: z.enum(["csv", "jsonl"]).default("csv"),
  from: isoDay.optional(),
  to: isoDay.optional(),
});
