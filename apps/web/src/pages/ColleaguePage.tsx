import type { Colleague } from "@orlok/shared";
import { Archive, ArchiveRestore, ArrowLeft, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { ColleagueForm } from "@/features/colleagues/ColleagueForm";
import { translateError } from "@/i18n/errors";
import { HeaderActions } from "@/layouts/HeaderActions";
import { useArchiveColleague, useColleague, useDeleteColleague } from "@/lib/colleague-queries";
import { useWorkspaceOffices } from "@/lib/workspace-queries";

function PageHeader({ title, back }: { title: string; back: string }) {
  const { t } = useTranslation();
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={back}
          className={buttonClasses("ghost", "icon")}
          aria-label={t("chat.back")}
          title={t("chat.back")}
        >
          <ArrowLeft aria-hidden />
        </Link>
        <h1 className="truncate font-semibold">{title}</h1>
      </div>
      <HeaderActions />
    </header>
  );
}

// Archive keeps the conversations; delete removes them and leaves only the colleague's name, so
// the wiki still says who wrote what (R-ADM-3).
function KeepOrRemove({ colleague }: { colleague: Colleague }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const archive = useArchiveColleague();
  const remove = useDeleteColleague();
  const archived = colleague.archivedAt !== null;
  const error = archive.error ?? remove.error;

  return (
    <section aria-labelledby="colleague-keep-title" className="space-y-4">
      <SectionHeader
        id="colleague-keep-title"
        title={t("colleagues.keep.title")}
        description={t("colleagues.keep.description")}
      />
      {error ? <ErrorAlert>{translateError(t, error)}</ErrorAlert> : null}
      <Card className="divide-y">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {archived ? t("colleagues.keep.archivedHint") : t("colleagues.keep.archiveHint")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={archive.isPending}
            onClick={() => archive.mutate({ id: colleague.id, archived: !archived })}
          >
            {archive.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : archived ? (
              <ArchiveRestore aria-hidden />
            ) : (
              <Archive aria-hidden />
            )}
            {archived ? t("colleagues.keep.restore") : t("colleagues.keep.archive")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t("colleagues.keep.deleteHint")}
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("colleagues.keep.deleteConfirm", { name: colleague.name }))) {
                remove.mutate(colleague.id, { onSuccess: () => navigate("/", { replace: true }) });
              }
            }}
          >
            <Trash2 aria-hidden />
            {t("common.delete")}
          </Button>
        </div>
      </Card>
    </section>
  );
}

function EditColleague({ colleagueId }: { colleagueId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const colleague = useColleague(colleagueId);
  const back = `/colleagues/${colleagueId}`;

  return (
    <>
      <PageHeader title={colleague.data?.name ?? t("colleagues.settings")} back={back} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          {colleague.isPending ? (
            <Loader2
              className="size-5 animate-spin text-primary"
              aria-label={t("common.loading")}
            />
          ) : colleague.isError ? (
            <ErrorAlert>{translateError(t, colleague.error)}</ErrorAlert>
          ) : (
            <>
              {colleague.data.needsProfile ? (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {t("colleagues.needsProfile")}
                </p>
              ) : null}
              <Card className="p-4">
                <ColleagueForm
                  key={colleague.data.id}
                  officeId={colleague.data.officeId}
                  colleague={colleague.data}
                  onSaved={() => navigate(back)}
                  onCancel={() => navigate(back)}
                />
              </Card>
              <KeepOrRemove colleague={colleague.data} />
            </>
          )}
        </div>
      </main>
    </>
  );
}

function NewColleague({ officeId }: { officeId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const offices = useWorkspaceOffices();
  const office = offices.data?.find((item) => item.id === officeId);

  return (
    <>
      <PageHeader
        title={office ? t("colleagues.newIn", { office: office.name }) : t("colleagues.new")}
        back="/"
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
          <p className="text-sm text-muted-foreground">{t("colleagues.newDescription")}</p>
          {offices.isError ? <ErrorAlert>{translateError(t, offices.error)}</ErrorAlert> : null}
          {offices.isSuccess && !office ? (
            <ErrorAlert>{t("colleagues.noOffice")}</ErrorAlert>
          ) : null}
          <Card className="p-4">
            <ColleagueForm
              officeId={officeId}
              onSaved={(created) => navigate(`/colleagues/${created.id}`)}
              onCancel={() => navigate("/")}
            />
          </Card>
        </div>
      </main>
    </>
  );
}

// A person's own colleague: created in one of their offices, then renamed, given another profile,
// archived or deleted (R-ADM-3).
export function ColleaguePage() {
  const { officeId, colleagueId } = useParams();
  return colleagueId ? (
    <EditColleague colleagueId={colleagueId} />
  ) : (
    <NewColleague officeId={officeId ?? ""} />
  );
}
