// Stable API error codes (R-I18N-4): clients translate them; the message is technical only.
export const ERROR_CODES = [
  "validation_failed",
  "invalid_credentials",
  // Too many failed logins for this account or address (R-SEC-7).
  "too_many_attempts",
  "unauthenticated",
  "forbidden",
  "already_configured",
  "conflict",
  // A message sent while the colleague is still answering the previous one (R-CHAT-13).
  "turn_in_progress",
  "not_found",
  "provider_error",
  "model_refused",
  // The conversation no longer fits the model window, even after summarizing it.
  "context_overflow",
  "model_not_configured",
  // The colleague's profile is gone or no longer granted to its owner: it needs another one.
  "colleague_needs_profile",
  // A model profile still granted to a person, or used for documents, cannot be deleted.
  "profile_in_use",
  "invitation_invalid",
  // A password reset link that is unknown, used, replaced or expired (R-AUTH-7).
  "password_reset_invalid",
  // A disabled person cannot be sent a password reset link: enable them first.
  "person_disabled",
  "last_admin",
  "self_change_not_allowed",
  "revision_conflict",
  // The wiki cannot be emptied while a document is being read into it.
  "wiki_busy",
  // A monthly spending limit of the installation, the office or the person was reached (R-MOD-4).
  "budget_exceeded",
  "unsupported_file",
  "file_too_large",
  "file_unreadable",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Per-field issue codes, used as messages in zod schemas.
export const ISSUE_CODES = [
  "required",
  "invalid_email",
  "invalid_url",
  "password_too_short",
  "too_long",
  "invalid_value",
  "invalid_max_output_tokens",
  "invalid_context_window",
  "exceeds_model_limit",
  // Another profile already has this model and mode.
  "profile_exists",
  // Another host, or another credential of the same person, already has this name.
  "name_taken",
  // The person already uses another of their credentials on one of these hosts.
  "host_has_credential",
  // A model profile the person was not granted (R-MOD-2).
  "not_granted",
  "email_taken",
  "invalid_slug",
  "slug_taken",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

export function isIssueCode(value: unknown): value is IssueCode {
  return typeof value === "string" && (ISSUE_CODES as readonly string[]).includes(value);
}

export type ApiIssue = {
  path: string;
  code: IssueCode;
  // Values for the translated message, e.g. { max: 64000 }.
  params?: Record<string, number>;
};

export type ApiError = {
  code: ErrorCode;
  message: string;
  issues?: ApiIssue[];
};
