import { existsSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

// Vite emits content-hashed file names under assets/: they never change, so browsers may keep
// them forever. Everything else (index.html, files copied from public/) must be revalidated.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

type FetchApp = { fetch: (request: Request, env?: unknown) => Response | Promise<Response> };

function isApiPath(pathname: string) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Serves the built web app next to the API (R-PRD-1): `/api` requests go to `api` unchanged,
 * existing files are served from `webDir`, and other GET paths fall back to index.html so the
 * client router can handle deep links. Missing files under /assets/ stay 404.
 */
export function withWebApp(api: FetchApp, webDir: string) {
  const root = path.resolve(webDir);
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(`ORLOK_WEB_DIR has no index.html: ${root}`);
  }
  const app = new Hono();

  app.all("*", async (c, next) => {
    if (isApiPath(c.req.path)) {
      return api.fetch(c.req.raw, c.env);
    }
    await next();
  });

  app.get(
    "*",
    async (c, next) => {
      c.header("Cache-Control", c.req.path.startsWith("/assets/") ? IMMUTABLE : REVALIDATE);
      await next();
    },
    serveStatic({ root }),
    async (c, next) => {
      if (c.req.path.startsWith("/assets/")) {
        c.header("Cache-Control", REVALIDATE);
        return c.text("Not found", 404);
      }
      c.header("Cache-Control", REVALIDATE);
      await next();
    },
    serveStatic({ root, path: "index.html" }),
  );

  return app;
}
