import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

const key = randomBytes(32);

describe("secret encryption", () => {
  it("round-trips and never stores the plaintext", () => {
    const payload = encryptSecret("sk-test-123", key);
    expect(payload).not.toContain("sk-test-123");
    expect(decryptSecret(payload, key)).toBe("sk-test-123");
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects a wrong key, tampered data and unknown formats", () => {
    const payload = encryptSecret("secret", key);
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();

    const parts = payload.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();

    expect(() => decryptSecret("v0:a:b:c", key)).toThrow("Unsupported secret format");
  });
});
