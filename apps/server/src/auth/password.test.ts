import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import { generateSessionToken, hashSessionToken } from "./tokens";

describe("password", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("a-long-password");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "a-long-password")).toBe(true);
    expect(await verifyPassword(hash, "another-password")).toBe(false);
  });

  it("treats a malformed hash as a wrong password", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("the dummy verification always fails", async () => {
    expect(await verifyAgainstDummy("orlok-dummy-password")).toBe(false);
  });
});

describe("session tokens", () => {
  it("are random and hash deterministically", () => {
    const token = generateSessionToken();
    expect(token).not.toBe(generateSessionToken());
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
