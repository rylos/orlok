import type {
  HostConnection,
  HostKind,
  McpServer,
  McpToolPolicy,
  McpTransport,
  OpsHost,
  RunnerHealth,
  WikiAuthor,
} from "@orlok/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

// Operations administration: runner, host registry, MCP servers, audit (R-OPS-1, R-OPS-10,
// R-SEC-1). Credentials are personal: see credential-queries.ts.

export type RunnerStatus = { configured: boolean; health: RunnerHealth | null; error?: string };

export type HostInput = {
  name?: string;
  kind?: HostKind;
  connection?: HostConnection;
  address?: string;
  port?: number;
  tags?: string[];
  description?: string | null;
  enabled?: boolean;
  resetHostKey?: boolean;
};

export type AuditEntry = {
  id: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  // A colleague comes with its owner, and keeps its name once deleted.
  actor: WikiAuthor;
  createdAt: string;
};

export const opsAdminKeys = {
  runner: ["admin", "ops", "runner"] as const,
  hosts: ["admin", "ops", "hosts"] as const,
  audit: (officeId: string) => ["admin", "ops", "audit", officeId] as const,
  installationAudit: ["admin", "ops", "audit", "installation"] as const,
};

export function useRunnerStatus() {
  return useQuery({
    queryKey: opsAdminKeys.runner,
    queryFn: () => apiFetch<RunnerStatus>("/admin/runner"),
    retry: false,
  });
}

// Every change is audited, so the audit list is refreshed too.
function useInvalidateOffice(officeId: string) {
  const queryClient = useQueryClient();
  return (...keys: (readonly unknown[])[]) =>
    Promise.all(
      [...keys, opsAdminKeys.audit(officeId)].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

export function useHosts() {
  return useQuery({
    queryKey: opsAdminKeys.hosts,
    queryFn: () => apiFetch<OpsHost[]>("/admin/hosts"),
  });
}

// Host changes are audited in the installation log, which is refreshed with them.
function useInvalidateHosts() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [opsAdminKeys.hosts, opsAdminKeys.installationAudit, ["me", "hosts"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

export function useSaveHost() {
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: HostInput }) =>
      id
        ? apiFetch<OpsHost>(`/admin/hosts/${id}`, { method: "PATCH", body: input })
        : apiFetch<OpsHost>("/admin/hosts", { method: "POST", body: input }),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteHost() {
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/hosts/${id}`, { method: "DELETE" }),
    // People's credentials lose the host too.
    onSuccess: () => invalidate(),
  });
}

export function useOpsAudit(officeId: string) {
  return useQuery({
    queryKey: opsAdminKeys.audit(officeId),
    queryFn: () => apiFetch<AuditEntry[]>(`/offices/${officeId}/ops/audit`),
    enabled: Boolean(officeId),
  });
}

// Events that belong to no office: hosts and people's credentials.
export function useInstallationAudit() {
  return useQuery({
    queryKey: opsAdminKeys.installationAudit,
    queryFn: () => apiFetch<AuditEntry[]>("/admin/audit"),
  });
}

export type McpServerInput = {
  name?: string;
  description?: string | null;
  transport?: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  // A null value removes a stored secret (update only).
  secrets?: Record<string, string | null>;
  toolPolicy?: McpToolPolicy;
  enabled?: boolean;
  // Tools colleagues are given; null for all of them.
  allowedTools?: string[] | null;
};

export const mcpAdminKeys = {
  servers: (officeId: string) => ["admin", "ops", "mcp", officeId] as const,
};

export function useMcpServers(officeId: string) {
  return useQuery({
    queryKey: mcpAdminKeys.servers(officeId),
    queryFn: () => apiFetch<McpServer[]>(`/admin/offices/${officeId}/mcp-servers`),
    enabled: Boolean(officeId),
  });
}

// Saving connects to the server and refreshes its tool list.
export function useSaveMcpServer(officeId: string) {
  const invalidate = useInvalidateOffice(officeId);
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: McpServerInput }) =>
      id
        ? apiFetch<McpServer>(`/admin/offices/${officeId}/mcp-servers/${id}`, {
            method: "PATCH",
            body: input,
          })
        : apiFetch<McpServer>(`/admin/offices/${officeId}/mcp-servers`, {
            method: "POST",
            body: input,
          }),
    onSuccess: () => invalidate(mcpAdminKeys.servers(officeId)),
  });
}

export function useRefreshMcpServer(officeId: string) {
  const invalidate = useInvalidateOffice(officeId);
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<McpServer>(`/admin/offices/${officeId}/mcp-servers/${id}/refresh`, {
        method: "POST",
      }),
    onSettled: () => invalidate(mcpAdminKeys.servers(officeId)),
  });
}

export function useDeleteMcpServer(officeId: string) {
  const invalidate = useInvalidateOffice(officeId);
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/admin/offices/${officeId}/mcp-servers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidate(mcpAdminKeys.servers(officeId)),
  });
}
