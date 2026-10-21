import type { ApprovedCommandType } from "@orlok/shared";
import { Loader2, Power, PowerOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CommandTypeSummary } from "@/features/account/CommandTypesSection";
import { translateError } from "@/i18n/errors";
import { usePersonCommandTypes, useSetPersonCommandTypeDisabled } from "@/lib/admin-queries";

function TypeRow({ personId, type }: { personId: string; type: ApprovedCommandType }) {
  const { t } = useTranslation();
  const toggle = useSetPersonCommandTypeDisabled(personId);
  const label = t(type.disabledBy ? "people.commandTypes.enable" : "people.commandTypes.disable");

  return (
    <li className="space-y-2 py-2 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <CommandTypeSummary type={type} />
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={toggle.isPending}
          aria-label={label}
          onClick={() => toggle.mutate({ id: type.id, disabled: !type.disabledBy })}
        >
          {toggle.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : type.disabledBy ? (
            <Power aria-hidden />
          ) : (
            <PowerOff aria-hidden />
          )}
          <span className="max-sm:sr-only">{label}</span>
        </Button>
      </div>
      {toggle.isError ? <ErrorAlert>{translateError(t, toggle.error)}</ErrorAlert> : null}
    </li>
  );
}

// The command types a person approved "always" (R-OPS-4), loaded when opened. An administrator
// turns one off for good: the person is then asked every time and cannot turn it on again.
export function PersonCommandTypes({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const types = usePersonCommandTypes(personId, open);

  return (
    <details
      className="text-sm"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t("people.commandTypes.title")}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">{t("people.commandTypes.hint")}</p>
        {types.isPending ? (
          <Loader2 className="size-4 animate-spin text-primary" aria-label={t("common.loading")} />
        ) : types.isError ? (
          <ErrorAlert>{translateError(t, types.error)}</ErrorAlert>
        ) : types.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("people.commandTypes.empty")}</p>
        ) : (
          <ul className="divide-y">
            {types.data.map((type) => (
              <TypeRow key={type.id} personId={personId} type={type} />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
