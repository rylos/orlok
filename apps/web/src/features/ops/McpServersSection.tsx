import type { McpCatalogEntry, McpServer } from "@orlok/shared";
import { ChevronDown, Loader2, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError } from "@/i18n/errors";
import { useDeleteMcpServer, useMcpServers, useRefreshMcpServer } from "@/lib/ops-admin-queries";
import { formatDateTime } from "./format";
import { McpCatalogPicker } from "./McpCatalogPicker";
import { McpPresetForm } from "./McpPresetForm";
import { McpServerForm } from "./McpServerForm";

function McpServerCard({
  officeId,
  server,
  onEdit,
}: {
  officeId: string;
  server: McpServer;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMcpServer(officeId);
  const remove = useDeleteMcpServer(officeId);
  const error = refresh.error ?? remove.error;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Plug className="size-4 text-primary" aria-hidden />
            <span className="font-mono font-medium break-all">{server.name}</span>
            <Badge variant="primary">{t(`ops.mcp.transports.${server.transport}`)}</Badge>
            {server.enabled ? null : <Badge>{t("ops.mcp.disabled")}</Badge>}
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">
            {server.transport === "http"
              ? server.url
              : [server.command, ...server.args].filter(Boolean).join(" ")}
          </p>
          {server.description ? (
            <p className="text-sm text-muted-foreground">{server.description}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t(`ops.mcp.toolPolicies.${server.toolPolicy}`)}
          </p>
          {server.toolsRefreshedAt ? (
            <p className="text-xs text-muted-foreground">
              {t("ops.mcp.refreshedAt", { time: formatDateTime(server.toolsRefreshedAt) })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(server.id)}
          >
            {refresh.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            {t("ops.mcp.refresh")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil aria-hidden />
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("ops.mcp.deleteConfirm", { name: server.name }))) {
                remove.mutate(server.id);
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      {server.lastError ? (
        <ErrorAlert>{t("ops.mcp.lastError", { message: server.lastError })}</ErrorAlert>
      ) : server.tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("ops.mcp.toolsNone")}</p>
      ) : (
        <details className="group rounded-md border bg-background">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
            {server.allowedTools
              ? t("ops.mcp.toolsAllowed", {
                  count: server.tools.filter((tool) => server.allowedTools?.includes(tool.name))
                    .length,
                  total: server.tools.length,
                })
              : t("ops.mcp.tools", { count: server.tools.length })}
          </summary>
          <ul className="max-h-80 divide-y overflow-auto border-t">
            {server.tools
              .filter((tool) => !server.allowedTools || server.allowedTools.includes(tool.name))
              .map((tool) => (
                <li key={tool.name} className="space-y-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs break-all">{tool.name}</span>
                    {tool.readOnly ? (
                      <Badge variant="success">{t("ops.mcp.readOnly")}</Badge>
                    ) : tool.destructive ? (
                      <Badge>{t("ops.mcp.destructive")}</Badge>
                    ) : null}
                  </div>
                  {tool.description ? (
                    <p className="text-xs text-muted-foreground line-clamp-2">{tool.description}</p>
                  ) : null}
                </li>
              ))}
          </ul>
        </details>
      )}
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
    </Card>
  );
}

// Model Context Protocol servers whose tools every colleague of the office may use (R-OPS-10).
export function McpServersSection({ officeId }: { officeId: string }) {
  const { t } = useTranslation();
  const servers = useMcpServers(officeId);
  const [creating, setCreating] = useState(false);
  // While creating: the catalog entry chosen, or null until one (or "manual") is picked.
  const [preset, setPreset] = useState<McpCatalogEntry | null>(null);
  const [picked, setPicked] = useState(false);
  // A catalog entry is filled in through its guided form, unless asked for the full one.
  const [manual, setManual] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function startCreating() {
    setCreating(true);
    setPreset(null);
    setPicked(false);
    setManual(false);
    setEditingId(null);
  }

  function stopCreating() {
    setCreating(false);
    setPreset(null);
    setPicked(false);
  }

  return (
    <section aria-labelledby="ops-mcp-title" className="space-y-4">
      <SectionHeader
        id="ops-mcp-title"
        title={t("ops.mcp.title")}
        description={t("ops.mcp.description")}
        action={
          creating ? null : (
            <Button size="sm" onClick={startCreating}>
              <Plus aria-hidden />
              {t("ops.mcp.add")}
            </Button>
          )
        }
      />

      {creating ? (
        <Card className="p-4">
          {picked && preset && !manual ? (
            <McpPresetForm
              officeId={officeId}
              preset={preset}
              onDone={stopCreating}
              onManual={() => setManual(true)}
            />
          ) : picked ? (
            <McpServerForm officeId={officeId} preset={preset ?? undefined} onDone={stopCreating} />
          ) : (
            <McpCatalogPicker
              onChoose={(entry) => {
                setPreset(entry);
                setPicked(true);
              }}
              onCancel={stopCreating}
            />
          )}
        </Card>
      ) : null}

      {servers.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : servers.isError ? (
        <ErrorAlert>{translateError(t, servers.error)}</ErrorAlert>
      ) : servers.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("ops.mcp.empty")}
          </p>
        )
      ) : (
        <ul className="grid gap-3">
          {servers.data.map((server) => (
            <li key={server.id}>
              {editingId === server.id ? (
                <Card className="p-4">
                  <McpServerForm
                    officeId={officeId}
                    server={server}
                    onDone={() => setEditingId(null)}
                  />
                </Card>
              ) : (
                <McpServerCard
                  officeId={officeId}
                  server={server}
                  onEdit={() => {
                    setEditingId(server.id);
                    setCreating(false);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
