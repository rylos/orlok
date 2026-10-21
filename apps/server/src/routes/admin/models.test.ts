import type {
  ApiError,
  ChatStreamEvent,
  ModelProfile,
  ModelProvider,
  ProviderModelsResult,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { createSession } from "../../auth/sessions";
import { modelProviders, users } from "../../db/schema";
import { decryptSecret } from "../../lib/crypto";
import type { LlmClientFactory, ProviderConnection } from "../../llm";
import { createTestDeps, resetDatabase } from "../../test/db";

const deps = createTestDeps();
const connections: ProviderConnection[] = [];

// Fake provider: records connections, fails listing for the key "bad", streams "Hello".
const fakeLlm: LlmClientFactory = (connection) => {
  connections.push(connection);
  return {
    async listModels() {
      if (connection.apiKey === "bad") {
        throw new Error("401: invalid x-api-key");
      }
      return [
        { id: "model-a", maxOutputTokens: 64_000, contextWindow: 200_000 },
        { id: "model-b", maxOutputTokens: null, contextWindow: null },
      ];
    },
    async *streamChat() {
      yield { type: "text", text: "Hel" };
      yield { type: "text", text: "lo" };
      yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
};

const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  connections.length = 0;
  const res = await app.request(
    "/api/setup",
    json("POST", {
      companyName: "Test Company",
      displayName: "Administrator",
      email: "admin@example.com",
      password: "a-very-long-password",
    }),
  );
  const match = (res.headers.get("set-cookie") ?? "").match(/orlok_session=([^;]+)/);
  adminCookie = `orlok_session=${match?.[1]}`;
});

function json(method: string, body?: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function asAdmin(path: string, method = "GET", body?: unknown) {
  return app.request(`/api/admin${path}`, json(method, body, adminCookie));
}

async function memberCookie() {
  const [member] = await deps.db
    .insert(users)
    .values({ email: "member@example.com", displayName: "Member", passwordHash: "x" })
    .returning();
  if (!member) {
    throw new Error("Member insert failed");
  }
  const { token } = await createSession(deps.db, { userId: member.id, persistent: false });
  return `orlok_session=${token}`;
}

async function createProvider(body: Record<string, unknown> = {}) {
  const res = await asAdmin("/providers", "POST", {
    name: "Meridian",
    kind: "anthropic",
    baseUrl: "http://192.0.2.10:3457",
    apiKey: "secret-key",
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ModelProvider;
}

async function createProfile(providerId: string, body: Record<string, unknown> = {}) {
  const res = await asAdmin("/profiles", "POST", {
    name: "Powerful",
    providerId,
    model: "claude-opus-5",
    mode: "ask",
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ModelProfile;
}

describe("admin access", () => {
  it("requires a session and the administrator role", async () => {
    const anonymous = await app.request("/api/admin/providers");
    expect(anonymous.status).toBe(401);

    const member = await app.request(
      "/api/admin/providers",
      json("GET", undefined, await memberCookie()),
    );
    expect(member.status).toBe(403);
    expect(((await member.json()) as ApiError).code).toBe("forbidden");
  });
});

describe("providers", () => {
  it("stores the API key encrypted and never returns it", async () => {
    const provider = await createProvider();
    expect(provider).toMatchObject({ name: "Meridian", kind: "anthropic", hasApiKey: true });
    expect(JSON.stringify(provider)).not.toContain("secret-key");

    const [row] = await deps.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, provider.id));
    expect(row?.apiKeyEncrypted).not.toContain("secret-key");
    expect(decryptSecret(row?.apiKeyEncrypted ?? "", deps.config.secretKey)).toBe("secret-key");
  });

  it("validates base URLs and requires one for OpenAI-compatible providers", async () => {
    const missing = await asAdmin("/providers", "POST", {
      name: "Local",
      kind: "openai_compatible",
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ApiError).issues).toEqual([
      { path: "baseUrl", code: "required" },
    ]);

    const invalid = await asAdmin("/providers", "POST", {
      name: "Local",
      kind: "ollama",
      baseUrl: "ftp://example.com",
    });
    expect(((await invalid.json()) as ApiError).issues).toEqual([
      { path: "baseUrl", code: "invalid_url" },
    ]);
  });

  it("rejects duplicate names", async () => {
    await createProvider();
    const res = await asAdmin("/providers", "POST", { name: "Meridian", kind: "openai" });
    expect(res.status).toBe(409);
  });

  it("keeps the key when omitted and removes it when null", async () => {
    const provider = await createProvider();

    const renamed = await asAdmin(`/providers/${provider.id}`, "PATCH", { name: "Meridian LAN" });
    expect(await renamed.json()).toMatchObject({ name: "Meridian LAN", hasApiKey: true });

    const cleared = await asAdmin(`/providers/${provider.id}`, "PATCH", { apiKey: null });
    expect(await cleared.json()).toMatchObject({ hasApiKey: false });
  });

  it("lists models with the decrypted key and reports failures", async () => {
    const provider = await createProvider();
    const res = await asAdmin(`/providers/${provider.id}/models`);
    expect((await res.json()) as ProviderModelsResult).toEqual({
      ok: true,
      models: [
        { id: "model-a", maxOutputTokens: 64_000, contextWindow: 200_000 },
        { id: "model-b", maxOutputTokens: null, contextWindow: null },
      ],
    });
    expect(connections.at(-1)).toEqual({
      kind: "anthropic",
      baseUrl: "http://192.0.2.10:3457",
      apiKey: "secret-key",
    });

    await asAdmin(`/providers/${provider.id}`, "PATCH", { apiKey: "bad" });
    const failed = await asAdmin(`/providers/${provider.id}/models`);
    expect(await failed.json()).toEqual({ ok: false, message: "401: invalid x-api-key" });
  });

  it("cannot be deleted while profiles use it", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id);

    expect((await asAdmin(`/providers/${provider.id}`, "DELETE")).status).toBe(409);
    expect((await asAdmin(`/profiles/${profile.id}`, "DELETE")).status).toBe(204);
    expect((await asAdmin(`/providers/${provider.id}`, "DELETE")).status).toBe(204);
  });
});

describe("profiles", () => {
  it("keeps one profile per model and mode, and only renames it", async () => {
    const provider = await createProvider();
    const asking = await createProfile(provider.id, { name: "Opus · ask" });
    expect(asking).toMatchObject({ model: "claude-opus-5", mode: "ask" });

    const twin = await asAdmin("/profiles", "POST", {
      name: "Opus again",
      providerId: provider.id,
      model: "claude-opus-5",
      mode: "ask",
    });
    expect(twin.status).toBe(409);
    expect(((await twin.json()) as ApiError).issues).toEqual([
      { path: "mode", code: "profile_exists" },
    ]);
    await createProfile(provider.id, { name: "Opus · full", mode: "full" });

    // The model and the mode are what the profile is: a request to change them renames at most.
    const renamed = await asAdmin(`/profiles/${asking.id}`, "PATCH", {
      name: "Opus careful",
      model: "claude-haiku-4-5",
      mode: "yolo",
      maxOutputTokens: 1_000,
    });
    expect(await renamed.json()).toMatchObject({
      name: "Opus careful",
      model: "claude-opus-5",
      mode: "ask",
      maxOutputTokens: asking.maxOutputTokens,
    });
  });

  it("cannot be deleted while a person or documents use it", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id);

    const [admin] = await deps.db.select().from(users);
    await asAdmin(`/people/${admin?.id}`, "PATCH", { profileIds: [profile.id] });
    const inUse = await asAdmin(`/profiles/${profile.id}`, "DELETE");
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as ApiError).code).toBe("profile_in_use");
    await asAdmin(`/people/${admin?.id}`, "PATCH", { profileIds: [] });

    await asAdmin("/documents", "PUT", { visionProfileId: profile.id });
    expect((await asAdmin(`/profiles/${profile.id}`, "DELETE")).status).toBe(409);
    await asAdmin("/documents", "PUT", { visionProfileId: null });
    expect((await asAdmin(`/profiles/${profile.id}`, "DELETE")).status).toBe(204);
  });

  it("rejects unknown providers and invalid token limits", async () => {
    const unknown = await asAdmin("/profiles", "POST", {
      name: "Ghost",
      providerId: "00000000-0000-4000-8000-000000000000",
      model: "any",
      mode: "ask",
    });
    expect(unknown.status).toBe(400);

    const provider = await createProvider();
    const tooMany = await asAdmin("/profiles", "POST", {
      name: "Huge",
      providerId: provider.id,
      model: "any",
      mode: "ask",
      maxOutputTokens: 1_000_000,
    });
    expect(((await tooMany.json()) as ApiError).issues).toEqual([
      { path: "maxOutputTokens", code: "invalid_max_output_tokens" },
    ]);
  });
});

describe("model output limits", () => {
  it("rejects more output tokens than the provider publishes for the model", async () => {
    const provider = await createProvider();
    const res = await asAdmin("/profiles", "POST", {
      name: "Too long",
      providerId: provider.id,
      model: "model-a",
      mode: "ask",
      maxOutputTokens: 100_000,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).issues).toEqual([
      { path: "maxOutputTokens", code: "exceeds_model_limit", params: { max: 64_000 } },
    ]);

    await createProfile(provider.id, { model: "model-a", maxOutputTokens: 64_000 });
  });

  it("accepts any valid limit when the provider does not publish one", async () => {
    const provider = await createProvider();
    await createProfile(provider.id, { model: "model-b", maxOutputTokens: 128_000 });
    await createProfile(provider.id, {
      name: "Unlisted",
      model: "other",
      maxOutputTokens: 128_000,
    });

    await asAdmin(`/providers/${provider.id}`, "PATCH", { apiKey: "bad" });
    await createProfile(provider.id, {
      name: "Offline",
      model: "model-a",
      maxOutputTokens: 128_000,
    });
  });
});

describe("context windows", () => {
  it("takes the window the provider publishes for the model", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id, { name: "Published", model: "model-a" });
    expect(profile.contextWindow).toBe(200_000);
  });

  it("falls back to what the model family is known for", async () => {
    // A gateway that publishes nothing at all, and the model is still Claude.
    const provider = await createProvider();
    const profile = await createProfile(provider.id, {
      name: "Known",
      model: "claude-sonnet-5",
    });
    expect(profile.contextWindow).toBe(1_000_000);
  });

  it("keeps the number an administrator typed, whatever anyone else says", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id, {
      name: "Typed",
      model: "claude-sonnet-5",
      contextWindow: 200_000,
    });
    expect(profile.contextWindow).toBe(200_000);
  });

  it("leaves it empty for a model nobody can vouch for", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id, { name: "Unknown", model: "model-b" });
    expect(profile.contextWindow).toBeNull();
  });
});

describe("playground", () => {
  it("streams the model answer as server-sent events", async () => {
    const provider = await createProvider();
    const profile = await createProfile(provider.id);

    const res = await asAdmin("/playground", "POST", {
      profileId: profile.id,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as ChatStreamEvent);
    const text = events.map((event) => (event.type === "text" ? event.text : "")).join("");
    expect(text).toBe("Hello");
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("refuses profiles whose provider is disabled", async () => {
    const provider = await createProvider({ enabled: false });
    const profile = await createProfile(provider.id);
    const res = await asAdmin("/playground", "POST", {
      profileId: profile.id,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(res.status).toBe(409);
  });
});
