import { wikiSearchSettingsSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { errorBody } from "../../lib/errors";
import { validate } from "../../lib/validation";
import { findProfile } from "../../services/models";
import { getWikiSearchSettings, saveWikiSearchSettings } from "../../services/wiki-search-settings";
import type { AppEnv, Deps } from "../../types";

// How colleagues search the wiki before answering (R-MEM-4), administrators only.
export function wikiSearchRoutes({ db }: Deps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await getWikiSearchSettings(db)))
    .put("/", validate("json", wikiSearchSettingsSchema), async (c) => {
      const input = c.req.valid("json");
      if (input.queryProfileId && !(await findProfile(db, input.queryProfileId))) {
        return c.json(
          errorBody("validation_failed", "Unknown model profile", [
            { path: "queryProfileId", code: "invalid_value" },
          ]),
          400,
        );
      }
      return c.json(await saveWikiSearchSettings(db, input));
    });
}
