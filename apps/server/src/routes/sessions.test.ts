import type { ActiveSession, Me } from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createTestDeps, resetDatabase } from "../test/db";
import { createMember, jsonRequest, sessionCookieFrom, setupAdmin } from "../test/http";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

async function signIn(email: string, password: string, userAgent: string) {
  const res = await app.request("/api/auth/login", {
    ...jsonRequest("POST", { email, password, remember: true }),
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
  });
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

async function listSessions(cookie: string) {
  const res = await app.request("/api/me/sessions", jsonRequest("GET", undefined, cookie));
  return { res, body: res.status === 200 ? ((await res.json()) as ActiveSession[]) : [] };
}

describe("active sessions (R-AUTH-5)", () => {
  it("lists the person's sessions and revokes one or all the others", async () => {
    const me = (await (
      await app.request("/api/me", jsonRequest("GET", undefined, adminCookie))
    ).json()) as Me;
    // setupAdmin uses this password; sign in twice more from two browsers.
    const phone = await signIn(me.email, "a-very-long-password", "Mozilla/5.0 (Android)");
    const laptop = await signIn(me.email, "a-very-long-password", "Mozilla/5.0 (X11)");

    const listed = await listSessions(laptop);
    expect(listed.body).toHaveLength(3);
    expect(listed.body.filter((session) => session.current)).toHaveLength(1);
    expect(listed.body.find((session) => session.current)?.userAgent).toBe("Mozilla/5.0 (X11)");

    // Another person cannot see or revoke these sessions.
    const member = await createMember(deps.db, "member@example.com");
    const foreign = listed.body.find((session) => !session.current);
    expect((await listSessions(member.cookie)).body).toHaveLength(1);
    const denied = await app.request(
      `/api/me/sessions/${foreign?.id}`,
      jsonRequest("DELETE", undefined, member.cookie),
    );
    expect(denied.status).toBe(404);

    // Revoking the phone signs it out.
    const phoneSession = listed.body.find(
      (session) => session.userAgent === "Mozilla/5.0 (Android)",
    );
    const revoked = await app.request(
      `/api/me/sessions/${phoneSession?.id}`,
      jsonRequest("DELETE", undefined, laptop),
    );
    expect(revoked.status).toBe(204);
    expect((await listSessions(phone)).res.status).toBe(401);

    // Signing out everywhere else keeps only the current session.
    const others = await app.request("/api/me/sessions", jsonRequest("DELETE", undefined, laptop));
    expect(others.status).toBe(204);
    expect((await listSessions(adminCookie)).res.status).toBe(401);
    expect((await listSessions(laptop)).body).toHaveLength(1);
  });
});
