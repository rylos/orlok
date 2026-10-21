import type { Conversation } from "@orlok/shared";
import { useTranslation } from "react-i18next";
import { formatNumber } from "@/i18n/errors";
import { cn } from "@/lib/utils";

// How full the model's window is. The number is the one the provider billed for the last answer,
// not an estimate, so it is worth showing: a conversation that keeps growing is about to be
// summarized, and people would rather see that coming than discover it afterwards.
const CROWDED = 75;
const FULL = 90;

export function ContextMeter({ conversation }: { conversation: Conversation }) {
  const { t } = useTranslation();
  const window = conversation.contextWindow;
  const used = conversation.messages.findLast((message) => message.usage)?.usage?.inputTokens;
  if (!window || used === undefined) {
    return null;
  }
  const percent = Math.min(100, Math.round((used / window) * 100));
  const title = [
    t("chat.context.title", { used: formatNumber(used), total: formatNumber(window) }),
    conversation.compacted ? t("chat.context.compacted") : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex items-center gap-2" title={title}>
      <div
        className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={title}
      >
        <div
          className={cn(
            "h-full rounded-full",
            percent >= FULL ? "bg-destructive" : percent >= CROWDED ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        className={cn(
          "text-xs whitespace-nowrap tabular-nums",
          percent >= FULL ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {t("chat.context.label", { percent })}
      </span>
    </div>
  );
}
