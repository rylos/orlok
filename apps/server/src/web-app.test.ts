import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestDeps } from "./test/db";
import { withWebApp } from "./web-app";

const deps = createTestDeps();
const webDir = mkdtempSync(path.join(os.tmpdir(), "orlok-web-"));
mkdirSync(path.join(webDir, "assets"));
writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Orlok</title>");
writeFileSync(path.join(webDir, "assets", "index-AbC123.js"), "console.log(1);");
writeFileSync(path.join(webDir, "favicon.svg"), "<svg></svg>");
const app = withWebApp(createApp(deps), webDir);

afterAll(async () => {
  rmSync(webDir, { recursive: true, force: true });
  await deps.close();
});

describe("built web app (R-PRD-1)", () => {
  it("passes API requests through, including JSON 404s", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const missing = await app.request("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "not_found", message: "Resource not found" });
  });

  it("serves index.html for the root and client routes without caching", async () => {
    for (const url of ["/", "/admin/offices", "/offices/1/wiki/some-page"]) {
      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>Orlok</title>");
    }
  });

  it("serves hashed assets as immutable and other files with revalidation", async () => {
    const asset = await app.request("/assets/index-AbC123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("console.log(1);");

    const icon = await app.request("/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 404 for missing assets instead of the HTML page", async () => {
    const res = await app.request("/assets/gone-XyZ.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("never serves files outside the web directory", async () => {
    const res = await app.request("/..%2f..%2fetc/passwd");
    expect(await res.text()).not.toContain("root:");
  });

  it("refuses a directory without index.html", () => {
    expect(() => withWebApp(createApp(deps), path.join(webDir, "assets"))).toThrow(/index\.html/);
  });
});
