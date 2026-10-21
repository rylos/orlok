import { zValidator } from "@hono/zod-validator";
import { isIssueCode } from "@orlok/shared";
import type { ValidationTargets } from "hono";
import { z } from "zod";
import { errorBody } from "./errors";

// zValidator with a uniform error response: 400 plus a code for every invalid field.
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        code: isIssueCode(issue.message) ? issue.message : ("invalid_value" as const),
      }));
      return c.json(errorBody("validation_failed", "Request validation failed", issues), 400);
    }
  });
}

export const idParamSchema = z.object({
  id: z.uuid({ error: "invalid_value" }),
});
