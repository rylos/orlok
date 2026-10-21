import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OfficeCard } from "@/features/offices/OfficeCard";
import { OfficeForm } from "@/features/offices/OfficeForm";
import { translateError } from "@/i18n/errors";
import { useAdminOffices, useProfiles } from "@/lib/admin-queries";

// Offices (R-ADM-2). Colleagues belong to each person, who creates them in their offices.
export function OfficesPage() {
  const { t } = useTranslation();
  const offices = useAdminOffices();
  const profiles = useProfiles();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("offices.title")}</h1>
          <p className="text-muted-foreground">{t("offices.description")}</p>
        </div>
        {creating ? null : (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t("offices.add")}
          </Button>
        )}
      </div>

      {profiles.data?.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/60 p-4 text-sm">
          <p>{t("offices.needProfile")}</p>
          <Link to="/admin/profiles" className={buttonClasses("outline", "sm")}>
            {t("offices.goToModels")}
          </Link>
        </div>
      ) : null}

      {creating ? (
        <Card className="p-4">
          <OfficeForm onDone={() => setCreating(false)} />
        </Card>
      ) : null}

      {offices.isPending ? (
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      ) : offices.isError ? (
        <ErrorAlert>{translateError(t, offices.error)}</ErrorAlert>
      ) : offices.data.length === 0 ? (
        creating ? null : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("offices.empty")}
          </p>
        )
      ) : (
        <ul className="space-y-4">
          {offices.data.map((office) => (
            <li key={office.id}>
              <OfficeCard office={office} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
