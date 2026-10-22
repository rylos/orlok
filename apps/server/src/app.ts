import { type Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { sessionMiddleware } from "./auth/middleware";
import { errorBody } from "./lib/errors";
import { adminRoutes } from "./routes/admin";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { colleagueRoutes } from "./routes/colleagues";
import { conversationRoutes } from "./routes/conversations";
import { credentialRoutes } from "./routes/credentials";
import { publicInvitationRoutes } from "./routes/invitations";
import { meRoutes } from "./routes/me";
import { opsRoutes } from "./routes/ops";
import { passwordResetRoutes } from "./routes/password-resets";
import { setupRoutes } from "./routes/setup";
import { wikiRoutes } from "./routes/wiki";
import { workspaceRoutes } from "./routes/workspace";
import type { AppEnv, Deps } from "./types";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>().basePath("/api");

  // Form-like posts (multipart uploads) must come from Orlok itself. Browsers on plain http
  // send no Sec-Fetch-Site, and behind a proxy (Vite in development, a reverse proxy in
  // production) the request URL is not the address people use, so the forwarded host counts.
  const publicOrigin = new URL(deps.config.publicUrl).origin;
  app.use(csrf({ origin: (origin, c) => requestOrigins(c, publicOrigin).includes(origin) }));
  app.use(sessionMiddleware(deps));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/setup", setupRoutes(deps));
  app.route("/auth", authRoutes(deps));
  app.route("/me", meRoutes(deps));
  app.route("/me", credentialRoutes(deps));
  app.route("/invitations", publicInvitationRoutes(deps));
  app.route("/password-resets", passwordResetRoutes(deps));
  app.route("/workspace", workspaceRoutes(deps));
  app.route("/colleagues", colleagueRoutes(deps));
  app.route("/conversations", conversationRoutes(deps));
  app.route("/attachments", attachmentRoutes(deps));
  app.route("/offices", wikiRoutes(deps));
  app.route("/offices", opsRoutes(deps));
  app.route("/admin", adminRoutes(deps));

  app.notFound((c) => c.json(errorBody("not_found", "Resource not found"), 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const code =
        err.status === 401
          ? "unauthenticated"
          : err.status === 403
            ? "forbidden"
            : "internal_error";
      return c.json(errorBody(code, err.message), err.status);
    }
    console.error(err);
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

// Origins a same-site request may carry: the request URL, the public URL and the host the
// browser used as reported by a proxy. Cross-site pages cannot set X-Forwarded-* headers.
function requestOrigins(c: Context, publicOrigin: string) {
  const url = new URL(c.req.url);
  const first = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined;
  const protocol = first(c.req.header("x-forwarded-proto")) ?? url.protocol.replace(":", "");
  const hosts = [first(c.req.header("x-forwarded-host")), c.req.header("host")].filter(
    (host): host is string => Boolean(host),
  );
  return [url.origin, publicOrigin, ...hosts.map((host) => `${protocol}://${host}`)];
}
