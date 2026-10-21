import type { Me } from "@orlok/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { errorBody } from "../lib/errors";
import type { AppEnv, Deps } from "../types";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie, validateSession } from "./sessions";

export function sessionMiddleware({ db, config }: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("user", null);
    c.set("sessionToken", null);

    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const result = await validateSession(db, token);
      if (result) {
        c.set("user", result.user);
        c.set("sessionToken", token);
        if (result.renewed) {
          setSessionCookie(c, token, result.session, config.secureCookies);
        }
      } else {
        clearSessionCookie(c);
      }
    }

    await next();
  });
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) {
    return c.json(errorBody("unauthenticated", "Authentication required"), 401);
  }
  await next();
});

export function currentUser(c: Context<AppEnv>): Me {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  return user;
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json(errorBody("unauthenticated", "Authentication required"), 401);
  }
  if (user.role !== "admin") {
    return c.json(errorBody("forbidden", "Administrator role required"), 403);
  }
  await next();
});
