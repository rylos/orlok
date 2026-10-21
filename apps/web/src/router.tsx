import { useEffect, useRef } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError } from "react-router";
import { FullPageError, FullPageLoader } from "@/components/FullPageState";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { WorkspaceLayout } from "@/layouts/WorkspaceLayout";
import { useMe, useSetupStatus } from "@/lib/queries";
import { returnPath, returnState } from "@/lib/return-path";
import { isStaleAppError, reloadOnce } from "@/lib/stale-app";
import { LoginPage } from "@/pages/LoginPage";
import { SetupPage } from "@/pages/SetupPage";
import { WorkspaceHome } from "@/pages/WorkspaceHome";

type Area = "setup" | "login" | "app";

// Decides where the user may be: first-run setup, sign-in or the authenticated area.
function Gate({ area }: { area: Area }) {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();

  if (setup.isPending || me.isPending) {
    return <FullPageLoader />;
  }
  if (setup.isError || me.isError) {
    return (
      <FullPageError
        error={setup.error ?? me.error}
        onRetry={() => {
          void setup.refetch();
          void me.refetch();
        }}
      />
    );
  }

  const target: Area = setup.data.needsSetup ? "setup" : me.data ? "app" : "login";
  if (target !== area) {
    // Sent to sign in from a page of the app: that page opens again once signed in.
    if (target === "login" && area === "app") {
      return <Navigate to="/login" replace state={returnState(location)} />;
    }
    if (target === "app" && area === "login") {
      return <Navigate to={returnPath(location.state)} replace />;
    }
    return <Navigate to={target === "app" ? "/" : `/${target}`} replace />;
  }
  // Signed in: the command palette (Ctrl+K) works on every page, workspace and administration.
  if (area === "app") {
    return (
      <>
        <Outlet />
        <CommandPalette />
      </>
    );
  }
  return <Outlet />;
}

// Anything a route throws ends here, including a page of the app that no longer exists because
// the server was updated while this one stayed open: that one loads itself again.
function RouteError() {
  const error = useRouteError();
  const handled = useRef(false);
  useEffect(() => {
    if (!handled.current && isStaleAppError(error)) {
      handled.current = true;
      reloadOnce();
    }
  }, [error]);
  return <FullPageError error={error} onRetry={() => window.location.reload()} />;
}

function AdminOnly() {
  const { data: me } = useMe();
  return me?.role === "admin" ? <Outlet /> : <Navigate to="/" replace />;
}

// Chat and administration are loaded on demand to keep the main bundle small; the fallback
// is shown while a lazy page loads on a direct visit.
export const router = createBrowserRouter([
  {
    element: <Gate area="setup" />,
    errorElement: <RouteError />,
    children: [{ path: "/setup", element: <SetupPage /> }],
  },
  {
    element: <Gate area="login" />,
    errorElement: <RouteError />,
    children: [{ path: "/login", element: <LoginPage /> }],
  },
  {
    element: <Gate area="app" />,
    errorElement: <RouteError />,
    children: [
      {
        element: <WorkspaceLayout />,
        children: [
          { path: "/", element: <WorkspaceHome /> },
          {
            path: "/account",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({ Component: (await import("@/pages/AccountPage")).AccountPage }),
          },
          {
            path: "/offices/:officeId/colleagues/new",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({
              Component: (await import("@/pages/ColleaguePage")).ColleaguePage,
            }),
          },
          {
            path: "/colleagues/:colleagueId/_settings",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({
              Component: (await import("@/pages/ColleaguePage")).ColleaguePage,
            }),
          },
          {
            path: "/colleagues/:colleagueId/:conversationId?",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({ Component: (await import("@/pages/ChatPage")).ChatPage }),
          },
          {
            path: "/offices/:officeId/wiki",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({
              Component: (await import("@/pages/wiki/WikiLayout")).WikiLayout,
            }),
            children: [
              {
                index: true,
                HydrateFallback: FullPageLoader,
                lazy: async () => ({ Component: (await import("@/pages/wiki/WikiHome")).WikiHome }),
              },
              // Names starting with "_" cannot be slugs, so they never hide a page.
              {
                path: "_new",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiEditor")).WikiNewPage,
                }),
              },
              {
                path: "_import",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiImport")).WikiImport,
                }),
              },
              {
                path: "_graph",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiGraph")).WikiGraph,
                }),
              },
              {
                path: "_review",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiReview")).WikiReview,
                }),
              },
              {
                path: "_log",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({ Component: (await import("@/pages/wiki/WikiLog")).WikiLog }),
              },
              {
                path: ":slug",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiPageView")).WikiPageView,
                }),
              },
              {
                path: ":slug/edit",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiEditor")).WikiEditPage,
                }),
              },
              {
                path: ":slug/history",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/wiki/WikiHistory")).WikiHistory,
                }),
              },
            ],
          },
        ],
      },
      {
        element: <AdminOnly />,
        children: [
          {
            path: "/admin",
            HydrateFallback: FullPageLoader,
            lazy: async () => ({ Component: (await import("@/layouts/AdminLayout")).AdminLayout }),
            children: [
              { index: true, element: <Navigate to="offices" replace /> },
              {
                path: "offices",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/OfficesPage")).OfficesPage,
                }),
              },
              {
                path: "people",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/PeoplePage")).PeoplePage,
                }),
              },
              {
                path: "profiles",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/ProfilesPage")).ProfilesPage,
                }),
              },
              {
                path: "hosts",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/HostsPage")).HostsPage,
                }),
              },
              {
                path: "email",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/EmailPage")).EmailPage,
                }),
              },
              {
                path: "models",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/ModelsPage")).ModelsPage,
                }),
              },
              {
                path: "costs",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/CostsPage")).CostsPage,
                }),
              },
              {
                path: "operations",
                HydrateFallback: FullPageLoader,
                lazy: async () => ({
                  Component: (await import("@/pages/admin/OpsPage")).OpsPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  // Public: accepting an invitation creates the account (R-ADM-4).
  {
    path: "/invite/:token",
    HydrateFallback: FullPageLoader,
    lazy: async () => ({ Component: (await import("@/pages/AcceptInvitePage")).AcceptInvitePage }),
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
