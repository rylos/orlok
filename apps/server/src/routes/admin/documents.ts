import { documentSettingsSchema } from "@orlok/shared/schemas";
import { Hono } from "hono";
import { errorBody } from "../../lib/errors";
import { validate } from "../../lib/validation";
import { getDocumentSettings, saveDocumentSettings } from "../../services/document-settings";
import { findProfile } from "../../services/models";
import type { AppEnv, Deps } from "../../types";

// How documents filed into the wikis are read (OCR and optional vision model), administrators only.
export function documentRoutes({ db }: Deps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await getDocumentSettings(db)))
    .put("/", validate("json", documentSettingsSchema), async (c) => {
      const input = c.req.valid("json");
      if (input.visionProfileId && !(await findProfile(db, input.visionProfileId))) {
        return c.json(
          errorBody("validation_failed", "Unknown model profile", [
            { path: "visionProfileId", code: "invalid_value" },
          ]),
          400,
        );
      }
      return c.json(await saveDocumentSettings(db, input));
    });
}
