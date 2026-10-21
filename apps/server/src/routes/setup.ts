import { setupSchema } from "@orlok/shared/schemas";
import { count, sql } from "drizzle-orm";
import { Hono } from "hono";
import { hashPassword } from "../auth/password";
import { createSession, setSessionCookie, toMe } from "../auth/sessions";
import { settings, users } from "../db/schema";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import {
  COMPANY_NAME_KEY,
  DEFAULT_LOCALE_KEY,
  getSetupStatus,
  SETUP_LOCK_ID,
} from "../services/installation";
import type { AppEnv, Deps } from "../types";

// First-run setup (R-ADM-1): allowed only while no user exists.
export function setupRoutes({ db, config }: Deps) {
  return new Hono<AppEnv>()
    .get("/status", async (c) => c.json({ ...(await getSetupStatus(db)), version: config.image }))
    .post("/", validate("json", setupSchema), async (c) => {
      const input = c.req.valid("json");

      const admin = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
        const [existing] = await tx.select({ total: count() }).from(users);
        if ((existing?.total ?? 0) > 0) {
          return null;
        }

        const [user] = await tx
          .insert(users)
          .values({
            email: input.email,
            displayName: input.displayName,
            passwordHash: await hashPassword(input.password),
            role: "admin",
            locale: input.locale,
          })
          .returning();

        for (const [key, value] of [
          [COMPANY_NAME_KEY, input.companyName],
          [DEFAULT_LOCALE_KEY, input.locale],
        ] as const) {
          await tx
            .insert(settings)
            .values({ key, value })
            .onConflictDoUpdate({ target: settings.key, set: { value } });
        }

        return user ?? null;
      });

      if (!admin) {
        return c.json(errorBody("already_configured", "Installation is already configured"), 409);
      }

      const { token, session } = await createSession(db, {
        userId: admin.id,
        persistent: true,
        userAgent: c.req.header("user-agent"),
      });
      setSessionCookie(c, token, session, config.secureCookies);

      return c.json(toMe(admin), 201);
    });
}
