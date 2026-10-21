import type { ApiError, Me, SetupStatus } from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { sessions } from "../db/schema";
import { createTestDeps, resetDatabase } from "../test/db";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());
beforeEach(() => resetDatabase(deps.db));

const admin = {
  companyName: "Test Company",
  displayName: "Administrator",
  email: "Admin@Example.com",
  password: "a-very-long-password",
};

function jsonRequest(method: string, body?: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function sessionCookie(res: Response) {
  const match = (res.headers.get("set-cookie") ?? "").match(/orlok_session=([^;]+)/);
  if (!match?.[1]) {
    throw new Error("Missing session cookie");
  }
  return `orlok_session=${match[1]}`;
}

async function runSetup(overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/setup", jsonRequest("POST", { ...admin, ...overrides }));
  expect(res.status).toBe(201);
  return sessionCookie(res);
}

function login(remember?: boolean) {
  return app.request(
    "/api/auth/login",
    jsonRequest("POST", { email: admin.email, password: admin.password, remember }),
  );
}

async function getMe(cookie?: string) {
  return app.request("/api/me", { headers: cookie ? { Cookie: cookie } : {} });
}

async function setupStatus() {
  return (await (await app.request("/api/setup/status")).json()) as SetupStatus;
}

describe("first-run setup", () => {
  it("reports that setup is needed on an empty installation", async () => {
    expect(await setupStatus()).toEqual({
      needsSetup: true,
      companyName: null,
      defaultLocale: "en",
      version: null,
    });
  });

  it("creates the administrator, opens a session and cannot run twice", async () => {
    const cookie = await runSetup();

    const me = (await (await getMe(cookie)).json()) as Me;
    expect(me).toMatchObject({
      email: "admin@example.com",
      role: "admin",
      themePreference: "system",
      locale: "en",
    });

    expect(await setupStatus()).toEqual({
      needsSetup: false,
      companyName: "Test Company",
      defaultLocale: "en",
      version: null,
    });

    const again = await app.request(
      "/api/setup",
      jsonRequest("POST", { ...admin, email: "other@example.com" }),
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiError).code).toBe("already_configured");
  });

  it("uses the chosen language for the administrator and the installation", async () => {
    const cookie = await runSetup({ locale: "it" });
    expect(((await (await getMe(cookie)).json()) as Me).locale).toBe("it");
    expect((await setupStatus()).defaultLocale).toBe("it");
  });

  it("returns a code for every invalid field", async () => {
    const res = await app.request(
      "/api/setup",
      jsonRequest("POST", { ...admin, email: "not-an-email", password: "short", locale: "fr" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.code).toBe("validation_failed");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        { path: "email", code: "invalid_email" },
        { path: "password", code: "password_too_short" },
        { path: "locale", code: "invalid_value" },
      ]),
    );
  });
});

describe("sign-in and sessions", () => {
  beforeEach(async () => {
    await runSetup();
  });

  it("rejects wrong credentials with the same response for known and unknown emails", async () => {
    const wrongPassword = await app.request(
      "/api/auth/login",
      jsonRequest("POST", { email: admin.email, password: "wrong-password-value" }),
    );
    const unknownEmail = await app.request(
      "/api/auth/login",
      jsonRequest("POST", { email: "nobody@example.com", password: "wrong-password-value" }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const body = (await wrongPassword.json()) as ApiError;
    expect(body.code).toBe("invalid_credentials");
    expect(await unknownEmail.json()).toEqual(body);
  });

  it("stops guessing after enough wrong passwords, without locking anyone else out", async () => {
    // A distinct address and mailbox: the brake outlives a single test, and the rest of this file
    // must keep signing in.
    const guess = (email: string) =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.10" },
        body: JSON.stringify({ email, password: "wrong-password-value" }),
      });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await guess("target@example.com")).status).toBe(401);
    }

    const refused = await guess("target@example.com");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as ApiError).code).toBe("too_many_attempts");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    // The administrator, another account from another address, is unaffected.
    expect((await login()).status).toBe(200);
  });

  it("sets a persistent cookie with remember me and a session cookie without", async () => {
    const persistent = await login(true);
    expect(persistent.status).toBe(200);
    expect(persistent.headers.get("set-cookie")).toMatch(/Expires=/);
    expect(persistent.headers.get("set-cookie")).toMatch(/HttpOnly/);

    const transient = await login(false);
    expect(transient.status).toBe(200);
    expect(transient.headers.get("set-cookie")).not.toMatch(/Expires=/);
  });

  it("answers /api/me with a coded 401 without a session", async () => {
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiError).code).toBe("unauthenticated");
    expect((await getMe("orlok_session=made-up-token")).status).toBe(401);
  });

  it("sign-out invalidates the session", async () => {
    const cookie = sessionCookie(await login(true));
    const logout = await app.request("/api/auth/logout", jsonRequest("POST", undefined, cookie));
    expect(logout.status).toBe(204);
    expect((await getMe(cookie)).status).toBe(401);
  });

  it("an expired session is no longer valid", async () => {
    const cookie = sessionCookie(await login(true));
    await deps.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await getMe(cookie)).status).toBe(401);
  });

  it("a session past half its lifetime is renewed", async () => {
    const cookie = sessionCookie(await login(true));
    await deps.db.update(sessions).set({ expiresAt: new Date(Date.now() + 60_000) });
    const me = await getMe(cookie);
    expect(me.status).toBe(200);
    expect(me.headers.get("set-cookie")).toMatch(/Expires=/);
  });
});

describe("preferences", () => {
  function patchPreferences(body: unknown, cookie: string) {
    return app.request("/api/me/preferences", jsonRequest("PATCH", body, cookie));
  }

  it("stores theme and language in the profile, also separately", async () => {
    const cookie = await runSetup();

    expect((await patchPreferences({ themePreference: "tokyo-night" }, cookie)).status).toBe(200);
    expect((await patchPreferences({ locale: "it" }, cookie)).status).toBe(200);

    expect(await (await getMe(cookie)).json()).toMatchObject({
      themePreference: "tokyo-night",
      locale: "it",
    });
  });

  it("rejects unknown values and empty requests", async () => {
    const cookie = await runSetup();
    expect((await patchPreferences({ themePreference: "dracula" }, cookie)).status).toBe(400);
    expect((await patchPreferences({ locale: "fr" }, cookie)).status).toBe(400);
    expect((await patchPreferences({}, cookie)).status).toBe(400);
  });
});
