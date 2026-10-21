import "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { LocaleSync } from "./i18n/LocaleSync";
import { ApiRequestError, onSessionEnded } from "./lib/api";
import { queryKeys } from "./lib/queries";
import { markSessionEnded } from "./lib/session-ended";
import { reloadOnce } from "./lib/stale-app";
import { router } from "./router";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ThemeSync } from "./theme/ThemeSync";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Retry only network or server errors, never responses such as 401/404.
      retry: (failureCount, error) =>
        failureCount < 2 && !(error instanceof ApiRequestError && error.status < 500),
    },
  },
});

// Only a session that was signed in can end: on the sign-in page the same answer just means
// "not signed in yet".
onSessionEnded(() => {
  if (queryClient.getQueryData(queryKeys.me)) {
    markSessionEnded();
    queryClient.setQueryData(queryKeys.me, null);
  }
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element in index.html");
}

// A piece of the app failed to load because the server now serves a newer build: load the page
// again, once, instead of leaving the person on a screen that cannot go on.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnce();
});

// Installable app and push notifications (R-CHAT-1, R-CHAT-7). Browsers allow service workers
// only on https or localhost; over plain http on a LAN address Orlok works without them.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ThemeSync />
        <LocaleSync />
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
