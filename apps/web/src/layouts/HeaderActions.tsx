import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isMac, openCommandPalette } from "@/features/palette/CommandPalette";
import { AccountMenu } from "./AccountMenu";

// Right side of the authenticated header: search and commands, then the person's own menu with
// account, language, theme, administration and signing out. At the foot of the side list (on a
// phone) the menu opens upwards.
export function HeaderActions({ side = "bottom" }: { side?: "bottom" | "top" }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      {/* The palette's shortcut is written on its button, where it can be discovered. */}
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("palette.open")}
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        title={t("palette.open")}
        onClick={openCommandPalette}
      >
        <Search aria-hidden />
        <kbd className="hidden rounded border bg-muted px-1.5 font-sans text-xs text-muted-foreground lg:inline">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </Button>
      <AccountMenu side={side} />
    </div>
  );
}
