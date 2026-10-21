import type { ExecMode, ModelProfile, ModelProvider } from "@orlok/shared";
import { Layers, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { translateError } from "@/i18n/errors";
import { useDeleteProfile } from "@/lib/admin-queries";

const MODE_BADGES: Record<ExecMode, "neutral" | "primary" | "warning"> = {
  deny: "neutral",
  ask: "neutral",
  full: "primary",
  yolo: "warning",
};

// How colleagues with a profile may run commands (R-MOD-2), as a badge.
export function ModeBadge({ mode }: { mode: ExecMode }) {
  const { t } = useTranslation();
  return (
    <Badge variant={MODE_BADGES[mode]}>
      {mode === "yolo" ? <TriangleAlert className="size-3" aria-hidden /> : null}
      {t(`profiles.modes.${mode}.label`)}
      {mode === "yolo" ? <span className="sr-only"> ({t("profiles.dangerous")})</span> : null}
    </Badge>
  );
}

type ProfileCardProps = {
  profile: ModelProfile;
  provider: ModelProvider | undefined;
  onEdit: () => void;
};

export function ProfileCard({ profile, provider, onEdit }: ProfileCardProps) {
  const { t, i18n } = useTranslation();
  const remove = useDeleteProfile();

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Layers className="size-4 text-primary" aria-hidden />
            <span className="font-medium">{profile.name}</span>
            <ModeBadge mode={profile.mode} />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider?.name ?? "—"} · {profile.model}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("profiles.maxOutputTokens")}:{" "}
            {profile.maxOutputTokens.toLocaleString(i18n.resolvedLanguage)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil aria-hidden />
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("profiles.deleteConfirm", { name: profile.name }))) {
                remove.mutate(profile.id);
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </div>
      {remove.error ? <ErrorAlert>{translateError(t, remove.error)}</ErrorAlert> : null}
    </Card>
  );
}
