import { Bot, MessagesSquare, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { buttonClasses } from "@/components/ui/button";
import { HeaderActions } from "@/layouts/HeaderActions";
import { useMyProfiles } from "@/lib/colleague-queries";
import { useMe } from "@/lib/queries";
import { useWorkspaceOffices } from "@/lib/workspace-queries";

export function WorkspaceHome() {
  const { t } = useTranslation();
  const offices = useWorkspaceOffices();
  const { data: me } = useMe();
  const profiles = useMyProfiles();
  const noProfiles = profiles.isSuccess && profiles.data.length === 0;
  const hasColleagues = offices.data?.some((office) => office.colleagues.length > 0) ?? false;

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="font-semibold">{t("workspace.title")}</h1>
        <HeaderActions />
      </header>
      <main className="grid flex-1 place-items-center p-6">
        {hasColleagues ? (
          <div className="max-w-sm space-y-3 text-center">
            <MessagesSquare className="mx-auto size-10 text-primary" aria-hidden />
            <p className="text-muted-foreground">{t("workspace.chooseColleague")}</p>
          </div>
        ) : offices.data && offices.data.length > 0 ? (
          // Colleagues are personal: each person creates their own (R-ADM-3).
          <div className="max-w-sm space-y-4 text-center">
            <Bot className="mx-auto size-10 text-primary" aria-hidden />
            {noProfiles ? (
              <p className="text-muted-foreground">
                {me?.role === "admin" ? t("workspace.noProfilesAdmin") : t("workspace.noProfiles")}
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">{t("workspace.createFirst")}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {offices.data.map((office) => (
                    <Link
                      key={office.id}
                      to={`/offices/${office.id}/colleagues/new`}
                      className={buttonClasses("outline", "sm")}
                    >
                      <Plus aria-hidden />
                      {offices.data.length > 1
                        ? t("colleagues.newIn", { office: office.name })
                        : t("colleagues.new")}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null}
      </main>
    </>
  );
}
