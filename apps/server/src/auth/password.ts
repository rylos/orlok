import { hash, verify } from "@node-rs/argon2";

// Argon2id with the minimum parameters recommended by OWASP.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string) {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

// Runs a throwaway verification when the user does not exist, so response times
// do not reveal which email addresses are registered.
export async function verifyAgainstDummy(password: string) {
  dummyHash ??= hashPassword("orlok-dummy-password");
  await verifyPassword(await dummyHash, password);
  return false;
}
