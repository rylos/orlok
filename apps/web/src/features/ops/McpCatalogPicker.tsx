import { MCP_CATALOG, type McpCatalogEntry } from "@orlok/shared";
import { Database, Plug, Server, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const ICONS = {
  database: Database,
  infrastructure: Server,
  office: Wrench,
  other: Plug,
} as const;

// Catalog of ready-made tools (R-OPS-15): pick one, or set a server up by hand.
export function McpCatalogPicker({
  onChoose,
  onCancel,
}: {
  onChoose: (entry: McpCatalogEntry | null) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium">{t("ops.mcp.catalog.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("ops.mcp.catalog.description")}</p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {MCP_CATALOG.map((entry) => {
          const Icon = ICONS[entry.category];
          return (
            <li
              key={entry.id}
              className="flex flex-col gap-2 rounded-md border bg-background p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Icon className="size-4 text-primary" aria-hidden />
                <span className="font-medium">{entry.name}</span>
                <Badge>{t(`ops.mcp.catalog.categories.${entry.category}`)}</Badge>
              </div>
              <p className="flex-1 text-muted-foreground">
                {t(`ops.mcp.catalog.entries.${entry.id}.description`)}
              </p>
              {entry.needsService ? (
                <p className="text-xs text-muted-foreground">{t("ops.mcp.catalog.needsSetup")}</p>
              ) : null}
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => onChoose(entry)}>
                  {t("ops.mcp.catalog.use")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p className="text-sm text-muted-foreground">{t("ops.mcp.catalog.manualHint")}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="outline" onClick={() => onChoose(null)}>
            {t("ops.mcp.catalog.manual")}
          </Button>
        </div>
      </div>
    </div>
  );
}
