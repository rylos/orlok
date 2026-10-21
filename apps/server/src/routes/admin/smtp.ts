import type { SmtpTestResult } from "@orlok/shared";
import { smtpSettingsSchema, smtpTestSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import { validate } from "../../lib/validation";
import { testEmail } from "../../mail";
import { getSmtpConnection, getSmtpSettings, saveSmtpSettings } from "../../services/smtp";
import type { AppEnv, Deps } from "../../types";

// SMTP settings (R-ADM-7), administrators only.
export function smtpRoutes({ db, config, mail }: Deps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await getSmtpSettings(db)))
    .put("/", validate("json", smtpSettingsSchema), async (c) =>
      c.json(await saveSmtpSettings(db, c.req.valid("json"), config.secretKey)),
    )
    .post("/test", validate("json", smtpTestSchema), async (c) => {
      const connection = await getSmtpConnection(db, config.secretKey);
      let result: SmtpTestResult;
      if (!connection) {
        result = { ok: false, message: "SMTP is not configured" };
      } else {
        try {
          await mail(connection).send({
            to: c.req.valid("json").to,
            ...testEmail(currentUser(c).locale),
          });
          result = { ok: true };
        } catch (error) {
          result = {
            ok: false,
            message: error instanceof Error ? error.message : "Unknown mail error",
          };
        }
      }
      return c.json(result);
    });
}
