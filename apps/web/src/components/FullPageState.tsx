import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/i18n/errors";
import { Button } from "./ui/button";

export function FullPageLoader() {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-dvh place-items-center">
      <Loader2 className="size-6 animate-spin text-primary" aria-label={t("common.loading")} />
    </div>
  );
}

export function FullPageError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="max-w-sm space-y-4 text-center">
        <h1 className="text-lg font-semibold">{t("errors.loadFailed")}</h1>
        <p className="text-sm text-muted-foreground">{translateError(t, error)}</p>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden /> {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}
