import type { z } from "zod";
import type { UserRole } from "./auth";
import type { Locale } from "./i18n";
import type { OfficeRole } from "./offices";
import type {
  invitationAcceptSchema,
  invitationCreateSchema,
  passwordResetSchema,
  personUpdateSchema,
} from "./schemas/people";

// People, office memberships and invitations (R-ADM-4).
export const INVITATION_TTL_DAYS = 7;

export type InvitationCreateInput = z.input<typeof invitationCreateSchema>;
export type PersonUpdateInput = z.input<typeof personUpdateSchema>;
export type InvitationAcceptInput = z.input<typeof invitationAcceptSchema>;

export type OfficeMembership = {
  officeId: string;
  role: OfficeRole;
};

export type Person = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  locale: Locale;
  disabled: boolean;
  memberships: OfficeMembership[];
  // Model profiles granted to the person (R-MOD-2): the ones their colleagues may use.
  profileIds: string[];
  createdAt: string;
};

export type Invitation = {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  locale: Locale;
  memberships: OfficeMembership[];
  profileIds: string[];
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
};

export type PeopleOverview = {
  people: Person[];
  invitations: Invitation[];
};

export type InvitationEmailStatus =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "failed"; message: string | null };

// The link is returned to the administrator so it can be shared when email is not available.
export type InvitationResult = {
  invitation: Invitation;
  inviteUrl: string;
  email: InvitationEmailStatus;
};

// A one-time link an administrator creates for a person to choose a new password (R-AUTH-7).
export const PASSWORD_RESET_TTL_HOURS = 24;

export type PasswordResetInput = z.input<typeof passwordResetSchema>;

// Like an invitation, the link is returned so it can be shared when the email did not leave.
export type PasswordResetResult = {
  person: { id: string; email: string; displayName: string };
  resetUrl: string;
  expiresAt: string;
  email: InvitationEmailStatus;
};

export type PasswordResetPreview = {
  email: string;
  displayName: string;
  companyName: string | null;
};

export type InvitationPreview = {
  email: string;
  displayName: string | null;
  companyName: string | null;
  invitedByName: string | null;
  locale: Locale;
};
