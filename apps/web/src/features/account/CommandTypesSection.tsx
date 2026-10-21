import type { ApprovedCommandType } from "@orlok/shared";
import { Loader2, Power, PowerOff, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { translateError } from "@/i18n/errors";
import { useCommandTypes, useDeleteCommandType, useSetCommandTypeDisabled } from "@/lib/queries";

// The type, its system and when it was approved, with what is shown about its state. Shared with
// the administrator's view of a person.
export function CommandTypeSummary({ type }: { type: ApprovedCommandType }) {
  const { t, i18n } = useTranslation();
  const date = new Date(type.createdAt).toLocaleDateString(i18n.resolvedLanguage, {
    dateStyle: "medium",
  });
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <code
        className={
          type.disabledBy
            ? "font-mono text-sm text-muted-foreground line-through [overflow-wrap:anywhere]"
            : "font-mono text-sm [overflow-wrap:anywhere]"
        }
      >
        {type.type}
      </code>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{t(`account.commandTypes.shells.${type.shell}`)}</span>
        <span aria-hidden>·</span>
        <span>{t("account.commandTypes.approvedOn", { date })}</span>
        {type.disabledBy ? (
          <Badge variant="warning">
            {t(
              type.disabledBy === "admin"
                ? "account.commandTypes.disabledByAdmin"
                : "account.commandTypes.disabled",
            )}
          </Badge>
        ) : null}
      </p>
    </div>
  );
}

function TypeRow({ type }: { type: ApprovedCommandType }) {
  const { t } = useTranslation();
  const toggle = useSetCommandTypeDisabled();
  const remove = useDeleteCommandType();
  const error = toggle.error ?? remove.error;
  // A type an administrator turned off is theirs to turn on again.
  const locked = type.disabledBy === "admin";

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <CommandTypeSummary type={type} />
        {locked ? null : (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={toggle.isPending}
              aria-label={t(
                type.disabledBy ? "account.commandTypes.enable" : "account.commandTypes.disable",
              )}
              onClick={() => toggle.mutate({ id: type.id, disabled: !type.disabledBy })}
            >
              {toggle.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : type.disabledBy ? (
                <Power aria-hidden />
              ) : (
                <PowerOff aria-hidden />
              )}
              <span className="max-sm:sr-only">
                {t(
                  type.disabledBy ? "account.commandTypes.enable" : "account.commandTypes.disable",
                )}
              </span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              aria-label={t("account.commandTypes.remove")}
              onClick={() => {
                if (window.confirm(t("account.commandTypes.removeConfirm"))) {
                  remove.mutate(type.id);
                }
              }}
            >
              {remove.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              <span className="max-sm:sr-only">{t("account.commandTypes.remove")}</span>
            </Button>
          </div>
        )}
      </div>
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
    </li>
  );
}

// Command types the person approved "always" (R-OPS-4): they spare only this person, with every
// colleague of theirs, on every host and on the runner. Turning one off makes colleagues ask again.
export function CommandTypesSection() {
  const { t } = useTranslation();
  const types = useCommandTypes();

  return (
    <section aria-labelledby="account-command-types-title" className="space-y-4">
      <SectionHeader
        id="account-command-types-title"
        title={t("account.commandTypes.title")}
        description={t("account.commandTypes.description")}
      />
      {types.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : types.isError ? (
        <ErrorAlert>{translateError(t, types.error)}</ErrorAlert>
      ) : types.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("account.commandTypes.empty")}</p>
      ) : (
        <Card className="p-4">
          <ul className="divide-y">
            {types.data.map((type) => (
              <TypeRow key={type.id} type={type} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
