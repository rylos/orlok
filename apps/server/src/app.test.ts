import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestDeps } from "./test/db";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

describe("GET /api/health", () => {
  it("responds ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("unknown routes", () => {
  it("respond with a JSON 404", async () => {
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found", message: "Resource not found" });
  });
});

function upload(headers: Record<string, string>) {
  const form = new FormData();
  form.append("file", new File(["x"], "notes.txt"));
  return app.request("/api/attachments", { method: "POST", body: form, headers });
}

describe("CSRF check on form posts", () => {
  it("accepts the host people use behind a proxy and rejects other sites", async () => {
    // Unauthenticated (401) means the request got past the CSRF check.
    expect(
      (
        await upload({
          Origin: "http://10.0.0.165:5173",
          "X-Forwarded-Host": "10.0.0.165:5173",
          "X-Forwarded-Proto": "http",
        })
      ).status,
    ).toBe(401);
    expect((await upload({ Origin: new URL(deps.config.publicUrl).origin })).status).toBe(401);
    expect((await upload({ Origin: "https://evil.example" })).status).toBe(403);
    expect(
      (await upload({ Origin: "https://evil.example", "X-Forwarded-Host": "10.0.0.165:5173" }))
        .status,
    ).toBe(403);
    expect((await upload({})).status).toBe(403);
  });
});
