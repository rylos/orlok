import type { ApiError, ApiIssue, ErrorCode } from "@orlok/shared";

// Uniform API error body: stable code plus a technical English message (R-I18N-4).
export function errorBody(code: ErrorCode, message: string, issues?: ApiIssue[]): ApiError {
  return issues ? { code, message, issues } : { code, message };
}

// The unique index a failed insert or update ran into, or null when that is not why it failed.
// Drizzle wraps the Postgres error, so the code is looked for on its cause too.
export function uniqueViolation(error: unknown): string | null {
  for (let current = error; typeof current === "object" && current !== null; ) {
    const { code, constraint_name, cause } = current as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (code === "23505") {
      return typeof constraint_name === "string" ? constraint_name : "";
    }
    current = cause;
  }
  return null;
}
