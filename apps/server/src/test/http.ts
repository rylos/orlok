import type { ChatStreamEvent, Colleague, Me } from "@orlok/shared";
import type { createApp } from "../app";
import { createSession } from "../auth/sessions";
import type { Db } from "../db/client";
import { officeMembers, profileGrants, users } from "../db/schema";

type App = ReturnType<typeof createApp>;

export function jsonRequest(method: string, body?: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function sessionCookieFrom(res: Response) {
  const match = (res.headers.get("set-cookie") ?? "").match(/orlok_session=([^;]+)/);
  if (!match?.[1]) {
    throw new Error("Missing session cookie");
  }
  return `orlok_session=${match[1]}`;
}

// Runs first-run setup and returns the administrator's session cookie.
export async function setupAdmin(app: App) {
  const res = await app.request(
    "/api/setup",
    jsonRequest("POST", {
      companyName: "Test Company",
      displayName: "Administrator",
      email: "admin@example.com",
      password: "a-very-long-password",
    }),
  );
  if (res.status !== 201) {
    throw new Error(`Setup failed with status ${res.status}`);
  }
  return sessionCookieFrom(res);
}

// Creates a member (optionally assigned to offices) and returns their session cookie.
export async function createMember(db: Db, email: string, officeIds: string[] = []) {
  const [member] = await db
    .insert(users)
    .values({ email, displayName: email.split("@")[0] ?? email, passwordHash: "x", locale: "it" })
    .returning();
  if (!member) {
    throw new Error("Member insert failed");
  }
  if (officeIds.length > 0) {
    await db
      .insert(officeMembers)
      .values(officeIds.map((officeId) => ({ officeId, userId: member.id })));
  }
  const { token } = await createSession(db, { userId: member.id, persistent: false });
  return { id: member.id, cookie: `orlok_session=${token}` };
}

// Creates a colleague of the person behind the cookie, granting them its profile first: colleagues
// are personal and use only the profiles their owner holds, administrators included (R-ADM-3,
// R-MOD-2). Returns the response like the tests' own call helpers.
export async function createColleague(
  app: App,
  db: Db,
  cookie: string,
  // Anything else is sent as it is, so tests can send what the API should refuse.
  input: { officeId: string; profileId?: string | null; [field: string]: unknown },
) {
  const me = (await (
    await app.request("/api/me", jsonRequest("GET", undefined, cookie))
  ).json()) as Me;
  if (typeof input.profileId === "string" && /^[0-9a-f-]{36}$/i.test(input.profileId)) {
    await db
      .insert(profileGrants)
      .values({ userId: me.id, profileId: input.profileId })
      .onConflictDoNothing();
  }
  const res = await app.request("/api/colleagues", jsonRequest("POST", input, cookie));
  return { res, body: (await res.json()) as Colleague };
}

export function parseSse(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ChatStreamEvent);
}
