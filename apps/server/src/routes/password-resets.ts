import type { PasswordResetPreview } from "@orlok/shared";
import { invitationTokenParamSchema, passwordResetSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { createSession, setSessionCookie, toMe } from "../auth/sessions";
import { errorBody } from "../lib/errors";
import { validate } from "../lib/validation";
import { getSetupStatus } from "../services/installation";
import {
  completePasswordReset,
  findPasswordResetUser,
  notifyPasswordChanged,
} from "../services/password-resets";
import type { AppEnv, Deps } from "../types";

const invalid = errorBody(
  "password_reset_invalid",
  "The password reset link is invalid, used or expired",
);

// Public side of password resets: the person opens the link an administrator created, chooses a
// new password and is signed in (R-AUTH-7).
export function passwordResetRoutes(deps: Deps) {
  const { db, config } = deps;
  return new Hono<AppEnv>()
    .get("/:token", validate("param", invitationTokenParamSchema), async (c) => {
      const user = await findPasswordResetUser(db, c.req.valid("param").token);
      if (!user) {
        return c.json(invalid, 404);
      }
      const preview: PasswordResetPreview = {
        email: user.email,
        displayName: user.displayName,
        companyName: (await getSetupStatus(db)).companyName,
      };
      return c.json(preview);
    })
    .post(
      "/:token",
      validate("param", invitationTokenParamSchema),
      validate("json", passwordResetSchema),
      async (c) => {
        const user = await completePasswordReset(
          db,
          c.req.valid("param").token,
          c.req.valid("json").password,
        );
        if (!user) {
          return c.json(invalid, 404);
        }
        const { token, session } = await createSession(db, {
          userId: user.id,
          persistent: false,
          userAgent: c.req.header("user-agent"),
        });
        setSessionCookie(c, token, session, config.secureCookies);
        await notifyPasswordChanged(deps, user, "link");
        return c.json(toMe(user));
      },
    );
}
