import type { ActiveSession, ApiError } from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createTestDeps, resetDatabase } from "../test/db";
import { jsonRequest, sessionCookieFrom, setupAdmin } from "../test/http";

// Changing one's own password (R-AUTH-6).

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

const EMAIL = "admin@example.com";
const OLD = "a-very-long-password";
const NEW = "an-even-longer-password";

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

function login(password: string) {
  return app.request(
    "/api/auth/login",
    jsonRequest("POST", { email: EMAIL, password, remember: true }),
  );
}

function change(body: Record<string, unknown>, cookie = adminCookie) {
  return app.request("/api/me/password", jsonRequest("PATCH", body, cookie));
}

describe("changing the password", () => {
  it("needs the current one, keeps this session and signs out the others", async () => {
    const other = sessionCookieFrom(await login(OLD));
    expect(
      (await app.request("/api/me/sessions", jsonRequest("GET", undefined, other))).status,
    ).toBe(200);

    const wrong = await change({ currentPassword: "not-the-password", newPassword: NEW });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiError).code).toBe("invalid_credentials");

    const short = await change({ currentPassword: OLD, newPassword: "short" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as ApiError).issues?.[0]).toMatchObject({
      path: "newPassword",
      code: "password_too_short",
    });

    expect((await change({ currentPassword: OLD, newPassword: NEW })).status).toBe(204);

    // The old password no longer works, the new one does.
    expect((await login(OLD)).status).toBe(401);
    expect((await login(NEW)).status).toBe(200);

    // The session that changed it stays, the other one is gone.
    const sessions = await app.request(
      "/api/me/sessions",
      jsonRequest("GET", undefined, adminCookie),
    );
    expect(sessions.status).toBe(200);
    expect(((await sessions.json()) as ActiveSession[]).filter((s) => s.current)).toHaveLength(1);
    expect(
      (await app.request("/api/me/sessions", jsonRequest("GET", undefined, other))).status,
    ).toBe(401);
  });
});
