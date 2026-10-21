import { loginSchema } from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { verifyAgainstDummy, verifyPassword } from "../auth/password";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  setSessionCookie,
  toMe,
} from "../auth/sessions";
import { users } from "../db/schema";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import { clientAddress, createLoginThrottle } from "../services/login-throttle";
import type { AppEnv, Deps } from "../types";

export function authRoutes({ db, config }: Deps) {
  // One brake per installation, kept in memory: a restart forgets the attempts, and there is only
  // ever one server process (R-SEC-7).
  const throttle = createLoginThrottle();

  return new Hono<AppEnv>()
    .post("/login", validate("json", loginSchema), async (c) => {
      const { email, password, remember } = c.req.valid("json");
      const attempt = { email, address: clientAddress(c) };

      // Checked before the password: a guess that is not even looked at costs the attacker the
      // wait, and costs us no hashing.
      const verdict = throttle.check(attempt);
      if (!verdict.allowed) {
        c.header("Retry-After", String(verdict.retryAfter));
        return c.json(
          errorBody("too_many_attempts", "Too many login attempts, try again later"),
          429,
        );
      }

      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const valid = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password);

      if (!user || !valid || user.disabledAt) {
        throttle.fail(attempt);
        return c.json(errorBody("invalid_credentials", "Invalid email or password"), 401);
      }

      throttle.succeed(attempt);
      const { token, session } = await createSession(db, {
        userId: user.id,
        persistent: remember,
        userAgent: c.req.header("user-agent"),
      });
      setSessionCookie(c, token, session, config.secureCookies);

      return c.json(toMe(user));
    })
    .post("/logout", async (c) => {
      const token = c.get("sessionToken");
      if (token) {
        await deleteSession(db, token);
      }
      clearSessionCookie(c);
      return c.body(null, 204);
    });
}
