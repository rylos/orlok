import { telegramBotSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { currentUser } from "../../auth/middleware";
import { errorBody } from "../../lib/errors";
import { validate } from "../../lib/validation";
import { audit } from "../../ops/audit";
import { deleteTelegramBot, getTelegramBotName, saveTelegramBot } from "../../telegram/settings";
import type { AppEnv, Deps } from "../../types";

// The installation's Telegram bot (R-CHAT-10): a token from @BotFather, checked with Telegram
// before it is saved, encrypted like provider keys.
export function telegramRoutes({ db, config, telegram }: Deps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const botUsername = await getTelegramBotName(db);
      return c.json({ configured: botUsername !== null, botUsername });
    })
    .put("/", validate("json", telegramBotSchema), async (c) => {
      const { token } = c.req.valid("json");
      let username: string | undefined;
      try {
        username = (await telegram(token).getMe()).username;
      } catch {
        username = undefined;
      }
      if (!username) {
        return c.json(
          errorBody("validation_failed", "Telegram did not accept the token", [
            { path: "token", code: "invalid_value" },
          ]),
          400,
        );
      }
      await saveTelegramBot(db, config.secretKey, { token, username });
      await audit(db, {
        officeId: null,
        actor: { userId: currentUser(c).id },
        action: "telegram.configured",
        target: username,
      });
      return c.json({ configured: true, botUsername: username });
    })
    .delete("/", async (c) => {
      await deleteTelegramBot(db);
      await audit(db, {
        officeId: null,
        actor: { userId: currentUser(c).id },
        action: "telegram.removed",
      });
      return c.body(null, 204);
    });
}
