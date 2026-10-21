import type {
  ApiError,
  InvitationPreview,
  InvitationResult,
  Me,
  Office,
  PeopleOverview,
  WorkspaceOffice,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { invitations, officeMembers } from "../db/schema";
import { createTestDeps, resetDatabase } from "../test/db";
import { jsonRequest, sessionCookieFrom, setupAdmin } from "../test/http";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie?: string) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function inviteWithOffice() {
  const office = await call<Office>("/admin/offices", "POST", { name: "IT Services" }, adminCookie);
  const { body } = await call<InvitationResult>(
    "/admin/invitations",
    "POST",
    {
      email: "anna@example.com",
      displayName: "Anna",
      locale: "it",
      memberships: [{ officeId: office.body.id }],
    },
    adminCookie,
  );
  return { office: office.body, token: body.inviteUrl.split("/").at(-1) ?? "" };
}

describe("accepting an invitation", () => {
  it("previews the invitation", async () => {
    const { token } = await inviteWithOffice();
    const preview = await call<InvitationPreview>(`/invitations/${token}`);
    expect(preview.body).toEqual({
      email: "anna@example.com",
      displayName: "Anna",
      companyName: "Test Company",
      invitedByName: "Administrator",
      locale: "it",
    });
  });

  it("creates the account with its offices and signs the person in", async () => {
    const { office, token } = await inviteWithOffice();

    const accepted = await call<Me>(`/invitations/${token}/accept`, "POST", {
      displayName: "Anna Rossi",
      password: "a-very-long-password",
    });
    expect(accepted.res.status).toBe(201);
    expect(accepted.body).toMatchObject({
      email: "anna@example.com",
      displayName: "Anna Rossi",
      role: "member",
      locale: "it",
    });

    const cookie = sessionCookieFrom(accepted.res);
    const offices = await call<WorkspaceOffice[]>("/workspace/offices", "GET", undefined, cookie);
    expect(offices.body.map((item) => item.id)).toEqual([office.id]);

    const login = await call("/auth/login", "POST", {
      email: "anna@example.com",
      password: "a-very-long-password",
    });
    expect(login.res.status).toBe(200);

    const reused = await call<ApiError>(`/invitations/${token}/accept`, "POST", {
      displayName: "Anna",
      password: "a-very-long-password",
    });
    expect(reused.res.status).toBe(404);
    expect(reused.body.code).toBe("invitation_invalid");
  });

  it("gives an invited administrator no offices, even from an older invitation", async () => {
    const { office, token } = await inviteWithOffice();
    // Before 2026-10-06 an invitation could make someone an administrator with offices too.
    await deps.db.update(invitations).set({ role: "admin" });

    const accepted = await call<Me>(`/invitations/${token}/accept`, "POST", {
      displayName: "Anna Rossi",
      password: "a-very-long-password",
    });
    expect(accepted.body.role).toBe("admin");
    const members = await deps.db
      .select()
      .from(officeMembers)
      .where(eq(officeMembers.officeId, office.id));
    expect(members).toEqual([]);
  });

  it("grants the model profiles of the invitation", async () => {
    const provider = await call<{ id: string }>(
      "/admin/providers",
      "POST",
      { name: "Provider", kind: "anthropic", apiKey: "x" },
      adminCookie,
    );
    const profile = await call<{ id: string }>(
      "/admin/profiles",
      "POST",
      { name: "Sonnet · ask", providerId: provider.body.id, model: "claude-sonnet-5", mode: "ask" },
      adminCookie,
    );
    const { body } = await call<InvitationResult>(
      "/admin/invitations",
      "POST",
      { email: "anna@example.com", profileIds: [profile.body.id] },
      adminCookie,
    );
    const token = body.inviteUrl.split("/").at(-1) ?? "";
    await call<Me>(`/invitations/${token}/accept`, "POST", {
      displayName: "Anna",
      password: "a-very-long-password",
    });

    const overview = await call<PeopleOverview>("/admin/people", "GET", undefined, adminCookie);
    const anna = overview.body.people.find((person) => person.email === "anna@example.com");
    expect(anna?.profileIds).toEqual([profile.body.id]);
  });

  it("rejects unknown and expired invitations and short passwords", async () => {
    expect((await call("/invitations/this-token-does-not-exist-at-all")).res.status).toBe(404);

    const { token } = await inviteWithOffice();
    const short = await call<ApiError>(`/invitations/${token}/accept`, "POST", {
      displayName: "Anna",
      password: "short",
    });
    expect(short.body.issues).toEqual([{ path: "password", code: "password_too_short" }]);

    await deps.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call(`/invitations/${token}`)).res.status).toBe(404);
  });
});
