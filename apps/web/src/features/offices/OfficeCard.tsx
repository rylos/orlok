import type { AdminOffice } from "@orlok/shared";
import { BookOpen, Building2, Eraser, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { translateError } from "@/i18n/errors";
import { useClearWiki, useDeleteOffice } from "@/lib/admin-queries";
import { OfficeForm } from "./OfficeForm";

// An office, its wiki and nothing of its people's colleagues, which are theirs alone (R-ADM-3).
export function OfficeCard({ office }: { office: AdminOffice }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const removeOffice = useDeleteOffice();
  const clearWiki = useClearWiki();
  const error = removeOffice.error ?? clearWiki.error;

  return (
    <Card className="space-y-4 p-4">
      {editing ? (
        <OfficeForm office={office} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Building2 className="size-4 text-primary" aria-hidden />
              <h2 className="font-semibold">{office.name}</h2>
            </div>
            {office.description ? (
              <p className="text-sm text-muted-foreground">{office.description}</p>
            ) : null}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <BookOpen className="size-3.5" aria-hidden />
              {t("offices.wiki.pages", { count: office.wikiPages })}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {t("common.edit")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={office.wikiPages === 0 || clearWiki.isPending}
              onClick={() => {
                // Typing the name, not a click: the whole wiki goes, with its history.
                const typed = window.prompt(
                  t("offices.wiki.clearConfirm", { name: office.name, count: office.wikiPages }),
                );
                if (typed?.trim() === office.name) {
                  clearWiki.mutate(office.id);
                } else if (typed !== null) {
                  window.alert(t("offices.wiki.clearMismatch"));
                }
              }}
            >
              <Eraser aria-hidden />
              {t("offices.wiki.clear")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={removeOffice.isPending}
              onClick={() => {
                if (window.confirm(t("offices.deleteConfirm", { name: office.name }))) {
                  removeOffice.mutate(office.id);
                }
              }}
            >
              <Trash2 aria-hidden />
              {t("common.delete")}
            </Button>
          </div>
        </div>
      )}

      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
      {clearWiki.data ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {t("offices.wiki.cleared", {
            pages: clearWiki.data.pages,
            sources: clearWiki.data.sources,
          })}{" "}
          <Link className="font-medium underline" to={`/offices/${office.id}/wiki/_import`}>
            {t("offices.wiki.importAgain")}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}
