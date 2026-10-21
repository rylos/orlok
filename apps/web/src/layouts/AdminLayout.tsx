import {
  ArrowLeft,
  Building2,
  Cpu,
  Layers,
  Mail,
  Receipt,
  Server,
  TerminalSquare,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";
import { buttonClasses } from "@/components/ui/button";
import { isWithoutOffice } from "@/features/people/without-office";
import { usePeople } from "@/lib/admin-queries";
import { cn } from "@/lib/utils";
import { HeaderActions } from "./HeaderActions";

const SECTIONS = [
  { to: "offices", labelKey: "nav.offices", icon: Building2 },
  { to: "people", labelKey: "nav.people", icon: Users },
  { to: "profiles", labelKey: "nav.profiles", icon: Layers },
  { to: "hosts", labelKey: "nav.hosts", icon: Server },
  { to: "models", labelKey: "nav.models", icon: Cpu },
  { to: "costs", labelKey: "nav.costs", icon: Receipt },
  { to: "email", labelKey: "nav.email", icon: Mail },
  { to: "operations", labelKey: "ops.nav", icon: TerminalSquare },
] as const;

export function AdminLayout() {
  const { t } = useTranslation();
  // Members who signed in to nothing are worth noticing from anywhere in the administration.
  const people = usePeople();
  const withoutOffice = (people.data?.people ?? []).filter(isWithoutOffice).length;

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className={buttonClasses("ghost", "sm")}>
            <ArrowLeft aria-hidden />
            <span className="hidden sm:inline">{t("nav.workspace")}</span>
          </Link>
          <span className="font-semibold">{t("nav.administration")}</span>
          <nav aria-label={t("nav.administration")} className="flex flex-wrap gap-1">
            {SECTIONS.map(({ to, labelKey, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(buttonClasses("ghost", "sm"), isActive && "bg-accent text-accent-foreground")
                }
              >
                <Icon aria-hidden />
                {t(labelKey)}
                {to === "people" && withoutOffice > 0 ? (
                  <span
                    className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full border border-warning/60 bg-warning/15 px-1.5 text-xs font-semibold text-foreground"
                    title={t("people.withoutOffice", { count: withoutOffice })}
                  >
                    <span aria-hidden>{withoutOffice}</span>
                    <span className="sr-only">
                      {t("people.withoutOffice", { count: withoutOffice })}
                    </span>
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
        </div>
        <HeaderActions />
      </header>
      <main className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
