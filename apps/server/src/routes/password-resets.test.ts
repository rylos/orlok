import type { ApiError, Me, PasswordResetPreview, PasswordResetResult } from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { auditEvents, users } from "../db/schema";
import type { MailerFactory, MailMessage } from "../mail";
import {
  generatePassword,
  notifyPasswordChanged,
  resetPasswordFromServer,
} from "../services/password-resets";
import { createTestDeps, resetDatabase } from "../test/db";
import { createMember, jsonRequest, sessionCookieFrom, setupAdmin } from "../test/http";

// Passwords reset by an administrator: a link from the app, a new password from the server
// command (R-AUTH-7).

const deps = createTestDeps();
const sent: MailMessage[] = [];
const fakeMail: MailerFactory = () => ({
  async send(message) {
    sent.push(message);
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

async function call<T>(path: string, method = "GET", body?: unknown, cookie?: string) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

function tokenOf(result: PasswordResetResult) {
  return result.resetUrl.split("/").at(-1) ?? "";
}

async function login(email: string, password: string) {
  return (await call("/auth/login", "POST", { email, password })).res.status;
}

async function actions() {
  const rows = await deps.db.select({ action: auditEvents.action }).from(auditEvents);
  return rows.map((row) => row.action);
}

describe("password reset links", () => {
  it("signs the person out, lets them choose a new password once and signs them in", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const created = await call<PasswordResetResult>(
      `/admin/people/${member.id}/password-reset`,
      "POST",
      undefined,
      adminCookie,
    );
    expect(created.res.status).toBe(201);
    expect(created.body.email).toEqual({ sent: false, reason: "not_configured", message: null });
    expect(created.body.resetUrl).toMatch(/^http:\/\/orlok\.test\/reset-password\/[\w-]{20,}$/);
    expect(created.body.person.email).toBe("member@example.com");
    // Their sessions ended with the link: the old password is no use from now on.
    expect((await call("/me", "GET", undefined, member.cookie)).res.status).toBe(401);

    const token = tokenOf(created.body);
    const preview = await call<PasswordResetPreview>(`/password-resets/${token}`);
    expect(preview.body).toEqual({
      email: "member@example.com",
      displayName: "member",
      companyName: "Test Company",
    });

    const short = await call<ApiError>(`/password-resets/${token}`, "POST", { password: "short" });
    expect(short.body.issues).toEqual([{ path: "password", code: "password_too_short" }]);

    const done = await call<Me>(`/password-resets/${token}`, "POST", {
      password: "a-brand-new-password",
    });
    expect(done.res.status).toBe(200);
    expect(done.body.email).toBe("member@example.com");
    const cookie = sessionCookieFrom(done.res);
    expect((await call("/me", "GET", undefined, cookie)).res.status).toBe(200);
    expect(await login("member@example.com", "a-brand-new-password")).toBe(200);

    const again = await call<ApiError>(`/password-resets/${token}`, "POST", {
      password: "another-new-password",
    });
    expect(again.res.status).toBe(404);
    expect(again.body.code).toBe("password_reset_invalid");
    expect(await actions()).toEqual(
      expect.arrayContaining(["person.password_reset_link", "person.password_reset"]),
    );
  });

  it("emails the link in the person's language", async () => {
    await call(
      "/admin/smtp",
      "PUT",
      { host: "smtp.example.com", port: 587, security: "starttls", fromAddress: "o@example.com" },
      adminCookie,
    );
    const member = await createMember(deps.db, "member@example.com");
    const created = await call<PasswordResetResult>(
      `/admin/people/${member.id}/password-reset`,
      "POST",
      undefined,
      adminCookie,
    );
    expect(created.body.email).toEqual({ sent: true });
    expect(sent[0]?.to).toBe("member@example.com");
    expect(sent[0]?.subject).toBe("Nuova password per Test Company su Orlok");
    expect(sent[0]?.text).toContain(created.body.resetUrl);
    expect(sent[0]?.text).toContain("Administrator");

    // Once the link is used, a notice confirms the change, without any link.
    await call(`/password-resets/${tokenOf(created.body)}`, "POST", {
      password: "a-brand-new-password",
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.to).toBe("member@example.com");
    expect(sent[1]?.subject).toBe("La password del tuo account Orlok è stata modificata");
    expect(sent[1]?.text).toContain("link di reimpostazione");
    expect(sent[1]?.text).not.toContain("http");
  });

  it("replaces the previous link and refuses disabled or unknown people", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const path = `/admin/people/${member.id}/password-reset`;
    const first = await call<PasswordResetResult>(path, "POST", undefined, adminCookie);
    const second = await call<PasswordResetResult>(path, "POST", undefined, adminCookie);
    expect((await call(`/password-resets/${tokenOf(first.body)}`)).res.status).toBe(404);
    expect((await call(`/password-resets/${tokenOf(second.body)}`)).res.status).toBe(200);

    // Disabled after the link was made: the link no longer works either.
    await call(`/admin/people/${member.id}`, "PATCH", { disabled: true }, adminCookie);
    expect((await call(`/password-resets/${tokenOf(second.body)}`)).res.status).toBe(404);
    const disabled = await call<ApiError>(path, "POST", undefined, adminCookie);
    expect(disabled.res.status).toBe(409);
    expect(disabled.body.code).toBe("person_disabled");

    const unknown = await call(
      "/admin/people/00000000-0000-4000-8000-000000000000/password-reset",
      "POST",
      undefined,
      adminCookie,
    );
    expect(unknown.res.status).toBe(404);
  });

  it("keeps the session of an administrator resetting their own password", async () => {
    const [admin] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@example.com"));
    const created = await call<PasswordResetResult>(
      `/admin/people/${admin?.id}/password-reset`,
      "POST",
      undefined,
      adminCookie,
    );
    expect(created.res.status).toBe(201);
    expect((await call("/me", "GET", undefined, adminCookie)).res.status).toBe(200);
  });

  it("is reserved to administrators", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const other = await createMember(deps.db, "other@example.com");
    const res = await call(
      `/admin/people/${other.id}/password-reset`,
      "POST",
      undefined,
      member.cookie,
    );
    expect(res.res.status).toBe(403);
  });
});

describe("password reset from the server", () => {
  it("sets a new password, ends every session and is logged", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const outcome = await resetPasswordFromServer(deps.db, " Member@Example.com ");
    if (!outcome.ok) {
      throw new Error("Reset refused");
    }
    expect(outcome.password).toMatch(/^[\w]{6}-[\w]{6}-[\w]{6}$/);
    expect((await call("/me", "GET", undefined, member.cookie)).res.status).toBe(401);
    expect(await login("member@example.com", outcome.password)).toBe(200);
    expect(await actions()).toContain("person.password_reset_server");
  });

  it("emails the person a notice, and goes on when email is not configured", async () => {
    const person = { email: "member@example.com", locale: "en" as const };
    const mailDeps = { ...deps, mail: fakeMail };
    expect(await notifyPasswordChanged(mailDeps, person, "server")).toEqual({
      sent: false,
      reason: "not_configured",
      message: null,
    });
    await call(
      "/admin/smtp",
      "PUT",
      { host: "smtp.example.com", port: 587, security: "starttls", fromAddress: "o@example.com" },
      adminCookie,
    );
    expect(await notifyPasswordChanged(mailDeps, person, "server")).toEqual({ sent: true });
    expect(sent[0]?.to).toBe("member@example.com");
    expect(sent[0]?.subject).toBe("Your Orlok password has been changed");
    expect(sent[0]?.text).toContain("directly on the server");
  });

  it("refuses unknown and disabled people", async () => {
    expect(await resetPasswordFromServer(deps.db, "nobody@example.com")).toEqual({
      ok: false,
      reason: "not_found",
    });
    const gone = await createMember(deps.db, "gone@example.com");
    await deps.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.id));
    expect(await resetPasswordFromServer(deps.db, "gone@example.com")).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("generates passwords without look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword()).not.toMatch(/[0O1lI]/);
    }
  });
});
