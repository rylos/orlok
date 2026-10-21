import type { WorkspaceColleague } from "@orlok/shared";
import {
  Archive,
  BookOpen,
  Bot,
  Building2,
  Loader2,
  Plus,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useMyProfiles } from "@/lib/colleague-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkspaceOffices } from "@/lib/workspace-queries";

function navItemClasses({ isActive }: { isActive: boolean }) {
  return cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
    "hover:bg-accent hover:text-accent-foreground",
    "focus-visible:outline-2 focus-visible:outline-ring",
    isActive && "bg-accent text-accent-foreground",
  );
}

// The colleague's own settings sit on its row, one tap away; the chat keeps what concerns the
// conversation. The button lies over the row, since a link cannot hold another.
function ColleagueLink({ colleague }: { colleague: WorkspaceColleague }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <NavLink
        to={`/colleagues/${colleague.id}`}
        className={(state) => cn(navItemClasses(state), "pr-9")}
      >
        <Bot className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{colleague.name}</span>
          {colleague.title ? (
            <span className="block truncate text-xs text-muted-foreground">{colleague.title}</span>
          ) : null}
        </span>
        {colleague.needsProfile ? (
          <TriangleAlert
            className="size-4 shrink-0 text-warning"
            aria-label={t("colleagues.needsProfileShort")}
          />
        ) : null}
      </NavLink>
      <Link
        to={`/colleagues/${colleague.id}/_settings`}
        className={cn(
          buttonClasses("ghost", "icon"),
          "absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground",
        )}
        aria-label={t("colleagues.settingsOf", { name: colleague.name })}
        title={t("colleagues.settings")}
      >
        <Settings2 aria-hidden />
      </Link>
    </div>
  );
}

export function OfficeNav() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const offices = useWorkspaceOffices();
  // Without a profile no colleague can be created: say who can grant one instead of offering it.
  const profiles = useMyProfiles();
  const noProfiles = profiles.isSuccess && profiles.data.length === 0;

  if (offices.isPending) {
    return (
      <div className="flex-1 px-4">
        <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
      </div>
    );
  }
  if (offices.isError) {
    return (
      <div className="flex-1 px-4">
        <ErrorAlert>{translateError(t, offices.error)}</ErrorAlert>
      </div>
    );
  }
  if (offices.data.length === 0) {
    return (
      <div className="flex-1 space-y-3 px-4 text-sm text-muted-foreground">
        {me?.role === "admin" ? (
          <>
            <p>{t("workspace.noOfficesAdmin")}</p>
            <Link to="/admin/offices" className={buttonClasses("primary", "sm")}>
              <Plus aria-hidden />
              {t("workspace.createOffice")}
            </Link>
          </>
        ) : (
          <p>{t("workspace.notAssigned")}</p>
        )}
      </div>
    );
  }

  return (
    <nav
      className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4"
      aria-label={t("workspace.offices")}
    >
      {offices.data.map((office) => (
        <div key={office.id}>
          <div className="mb-1 flex items-center gap-2 pl-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Building2 className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{office.name}</span>
            {/* Everyone creates their own colleagues, in each of their offices (R-ADM-3). */}
            {noProfiles ? null : (
              <Link
                to={`/offices/${office.id}/colleagues/new`}
                className={cn(buttonClasses("ghost", "icon"), "size-7 text-muted-foreground")}
                aria-label={t("colleagues.newIn", { office: office.name })}
                title={t("colleagues.newIn", { office: office.name })}
              >
                <Plus aria-hidden />
              </Link>
            )}
          </div>
          <ul className="space-y-0.5">
            <li>
              <NavLink to={`/offices/${office.id}/wiki`} className={navItemClasses}>
                <BookOpen className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">{t("wiki.title")}</span>
              </NavLink>
            </li>
            {office.colleagues.length === 0 && noProfiles ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {me?.role === "admin" ? t("workspace.noProfilesAdmin") : t("workspace.noProfiles")}
              </li>
            ) : office.colleagues.length === 0 ? (
              <li>
                <Link
                  to={`/offices/${office.id}/colleagues/new`}
                  className="block rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {t("workspace.emptyOffice")}
                </Link>
              </li>
            ) : null}
            {office.colleagues.map((colleague) => (
              <li key={colleague.id}>
                <ColleagueLink colleague={colleague} />
              </li>
            ))}
          </ul>
          {office.archived.length > 0 ? (
            <details className="mt-1">
              <summary className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                <Archive className="size-3.5" aria-hidden />
                {t("colleagues.archived", { count: office.archived.length })}
              </summary>
              <ul className="mt-0.5 space-y-0.5">
                {office.archived.map((colleague) => (
                  <li key={colleague.id}>
                    <ColleagueLink colleague={colleague} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </nav>
  );
}
