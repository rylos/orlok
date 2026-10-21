import type {
  ApiError,
  InvitationResult,
  Me,
  Office,
  PeopleOverview,
  Person,
  SmtpSettings,
  SmtpTestResult,
} from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { MailerFactory, MailMessage, SmtpConnection } from "../../mail";
import { createTestDeps, resetDatabase } from "../../test/db";
import { createMember, jsonRequest, setupAdmin } from "../../test/http";

const deps = createTestDeps();
const sent: { connection: SmtpConnection; message: MailMessage }[] = [];

// Fake SMTP: records emails, fails for the host "fail.example".
const fakeMail: MailerFactory = (connection) => ({
  async send(message) {
    if (connection.host === "fail.example") {
      throw new Error("Connection refused");
    }
    sent.push({ connection, message });
  },
});

const app = createApp({ ...deps, mail: fakeMail });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  sent.length = 0;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

const smtp = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "orlok",
  password: "smtp-secret",
  fromAddress: "orlok@example.com",
  fromName: "Orlok",
};

async function invite(body: Record<string, unknown> = {}) {
  const { res, body: result } = await call<InvitationResult>("/admin/invitations", "POST", {
    email: "New.Person@example.com",
    ...body,
  });
  expect(res.status).toBe(201);
  return result;
}

describe("SMTP settings", () => {
  it("stores the password encrypted, keeps it when omitted and sends a test email", async () => {
    expect((await call<SmtpSettings | null>("/admin/smtp")).body).toBeNull();

    const saved = await call<SmtpSettings>("/admin/smtp", "PUT", smtp);
    expect(saved.body).toEqual({ ...smtp, password: undefined, hasPassword: true });
    expect(JSON.stringify(saved.body)).not.toContain("smtp-secret");

    const { password: _, ...withoutPassword } = smtp;
    const kept = await call<SmtpSettings>("/admin/smtp", "PUT", { ...withoutPassword, port: 465 });
    expect(kept.body).toMatchObject({ port: 465, hasPassword: true });

    const test = await call<SmtpTestResult>("/admin/smtp/test", "POST", {
      to: "admin@example.com",
    });
    expect(test.body).toEqual({ ok: true });
    expect(sent[0]?.connection.password).toBe("smtp-secret");
    expect(sent[0]?.message).toMatchObject({
      to: "admin@example.com",
      subject: "Orlok test email",
    });
  });

  it("validates the port and reports test failures", async () => {
    const invalid = await call<ApiError>("/admin/smtp", "PUT", { ...smtp, port: 70_000 });
    expect(invalid.body.issues).toEqual([{ path: "port", code: "invalid_value" }]);

    const notConfigured = await call<SmtpTestResult>("/admin/smtp/test", "POST", {
      to: "a@example.com",
    });
    expect(notConfigured.body).toEqual({ ok: false, message: "SMTP is not configured" });

    await call("/admin/smtp", "PUT", { ...smtp, host: "fail.example" });
    const failed = await call<SmtpTestResult>("/admin/smtp/test", "POST", { to: "a@example.com" });
    expect(failed.body).toEqual({ ok: false, message: "Connection refused" });
  });
});

describe("invitations", () => {
  it("returns the link when email is not configured", async () => {
    const result = await invite();
    expect(result.email).toEqual({ sent: false, reason: "not_configured", message: null });
    expect(result.inviteUrl).toMatch(/^http:\/\/orlok\.test\/invite\/[\w-]{20,}$/);
    expect(result.invitation).toMatchObject({
      email: "new.person@example.com",
      role: "member",
      locale: "en",
      invitedByName: "Administrator",
    });
  });

  it("sends the invitation email in the chosen language with office memberships", async () => {
    await call("/admin/smtp", "PUT", smtp);
    const office = await call<Office>("/admin/offices", "POST", { name: "IT Services" });

    const result = await invite({
      locale: "it",
      memberships: [{ officeId: office.body.id, role: "manager" }],
    });
    expect(result.email).toEqual({ sent: true });
    expect(result.invitation.memberships).toEqual([{ officeId: office.body.id, role: "manager" }]);
    expect(sent[0]?.message.to).toBe("new.person@example.com");
    expect(sent[0]?.message.subject).toBe("Invito a Test Company su Orlok");
    expect(sent[0]?.message.text).toContain(result.inviteUrl);
    expect(sent[0]?.message.html).toContain("Accetta l'invito");
  });

  it("reports failed emails without losing the invitation", async () => {
    await call("/admin/smtp", "PUT", { ...smtp, host: "fail.example" });
    const result = await invite();
    expect(result.email).toEqual({ sent: false, reason: "failed", message: "Connection refused" });
    const overview = await call<PeopleOverview>("/admin/people");
    expect(overview.body.invitations).toHaveLength(1);
  });

  it("assigns no offices to an invited administrator", async () => {
    const office = await call<Office>("/admin/offices", "POST", { name: "IT Services" });
    const result = await invite({
      role: "admin",
      memberships: [{ officeId: office.body.id, role: "manager" }],
    });
    expect(result.invitation).toMatchObject({ role: "admin", memberships: [] });
    const overview = await call<PeopleOverview>("/admin/people");
    expect(overview.body.invitations[0]?.memberships).toEqual([]);
  });

  it("rejects existing people and unknown offices", async () => {
    const existing = await call<ApiError>("/admin/invitations", "POST", {
      email: "admin@example.com",
    });
    expect(existing.res.status).toBe(409);
    expect(existing.body.issues).toEqual([{ path: "email", code: "email_taken" }]);

    const unknownOffice = await call<ApiError>("/admin/invitations", "POST", {
      email: "x@example.com",
      memberships: [{ officeId: "00000000-0000-4000-8000-000000000000" }],
    });
    expect(unknownOffice.res.status).toBe(400);
  });

  it("replaces, resends and revokes invitations", async () => {
    const first = await invite();
    const second = await invite();
    const firstToken = first.inviteUrl.split("/").at(-1);
    expect((await call(`/invitations/${firstToken}`)).res.status).toBe(404);

    const resent = await call<InvitationResult>(
      `/admin/invitations/${second.invitation.id}/resend`,
      "POST",
    );
    expect(resent.body.inviteUrl).not.toBe(second.inviteUrl);
    expect((await call(`/invitations/${second.inviteUrl.split("/").at(-1)}`)).res.status).toBe(404);
    expect((await call(`/invitations/${resent.body.inviteUrl.split("/").at(-1)}`)).res.status).toBe(
      200,
    );

    expect((await call(`/admin/invitations/${second.invitation.id}`, "DELETE")).res.status).toBe(
      204,
    );
    expect((await call<PeopleOverview>("/admin/people")).body.invitations).toEqual([]);
  });

  it("is reserved to administrators", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const res = await call("/admin/people", "GET", undefined, member.cookie);
    expect(res.res.status).toBe(403);
  });
});

describe("people", () => {
  it("updates role and office memberships", async () => {
    const office = await call<Office>("/admin/offices", "POST", { name: "IT Services" });
    const member = await createMember(deps.db, "member@example.com");

    const updated = await call<Person>(`/admin/people/${member.id}`, "PATCH", {
      memberships: [{ officeId: office.body.id, role: "observer" }],
    });
    expect(updated.body.memberships).toEqual([{ officeId: office.body.id, role: "observer" }]);

    // An administrator works in every office: promoting someone leaves them none, and so does
    // saving offices for an administrator, so stepping back down starts from none.
    const promoted = await call<Person>(`/admin/people/${member.id}`, "PATCH", { role: "admin" });
    expect(promoted.body).toMatchObject({ role: "admin", memberships: [] });
    const ignored = await call<Person>(`/admin/people/${member.id}`, "PATCH", {
      memberships: [{ officeId: office.body.id, role: "manager" }],
    });
    expect(ignored.body.memberships).toEqual([]);
    const demoted = await call<Person>(`/admin/people/${member.id}`, "PATCH", { role: "member" });
    expect(demoted.body).toMatchObject({ role: "member", memberships: [] });

    const overview = await call<PeopleOverview>("/admin/people");
    expect(overview.body.people.map((person) => person.email).sort()).toEqual([
      "admin@example.com",
      "member@example.com",
    ]);
  });

  it("grants model profiles to people and invitations, and refuses unknown ones", async () => {
    const provider = await call<{ id: string }>("/admin/providers", "POST", {
      name: "Provider",
      kind: "anthropic",
      apiKey: "x",
    });
    const profile = await call<{ id: string }>("/admin/profiles", "POST", {
      name: "Sonnet · ask",
      providerId: provider.body.id,
      model: "claude-sonnet-5",
      mode: "ask",
    });
    const member = await createMember(deps.db, "member@example.com");

    const granted = await call<Person>(`/admin/people/${member.id}`, "PATCH", {
      profileIds: [profile.body.id],
    });
    expect(granted.body.profileIds).toEqual([profile.body.id]);
    const unknown = await call<ApiError>(`/admin/people/${member.id}`, "PATCH", {
      profileIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(unknown.res.status).toBe(400);
    expect(unknown.body.issues).toEqual([{ path: "profileIds", code: "invalid_value" }]);

    const invited = await invite({ profileIds: [profile.body.id] });
    expect(invited.invitation.profileIds).toEqual([profile.body.id]);
    const overview = await call<PeopleOverview>("/admin/people");
    expect(overview.body.invitations[0]?.profileIds).toEqual([profile.body.id]);
    expect(overview.body.people.find((person) => person.id === member.id)?.profileIds).toEqual([
      profile.body.id,
    ]);
  });

  it("prevents administrators from demoting or disabling themselves", async () => {
    const me = await call<Me>("/me");
    const res = await call<ApiError>(`/admin/people/${me.body.id}`, "PATCH", { disabled: true });
    expect(res.res.status).toBe(409);
    expect(res.body.code).toBe("self_change_not_allowed");
  });

  it("lets another administrator disable an administrator", async () => {
    const other = await createMember(deps.db, "other@example.com");
    await call(`/admin/people/${other.id}`, "PATCH", { role: "admin" });
    const me = await call<Me>("/me");
    // The second administrator disables the first one, but still cannot demote themselves.
    const byOther = await call<ApiError>(
      `/admin/people/${me.body.id}`,
      "PATCH",
      { disabled: true },
      other.cookie,
    );
    expect(byOther.res.status).toBe(200);
    const last = await call<ApiError>(
      `/admin/people/${other.id}`,
      "PATCH",
      { role: "member" },
      other.cookie,
    );
    expect(last.body.code).toBe("self_change_not_allowed");
  });

  it("disabling a person ends their sessions and blocks sign-in", async () => {
    const member = await createMember(deps.db, "member@example.com");
    expect((await call("/me", "GET", undefined, member.cookie)).res.status).toBe(200);

    const disabled = await call<Person>(`/admin/people/${member.id}`, "PATCH", { disabled: true });
    expect(disabled.body.disabled).toBe(true);
    expect((await call("/me", "GET", undefined, member.cookie)).res.status).toBe(401);

    const enabled = await call<Person>(`/admin/people/${member.id}`, "PATCH", { disabled: false });
    expect(enabled.body.disabled).toBe(false);
  });
});
