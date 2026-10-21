import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Secrets at rest (R-SEC-2): AES-256-GCM, stored as "v1:<iv>:<tag>:<ciphertext>" in base64.
const FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unsupported secret format");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
