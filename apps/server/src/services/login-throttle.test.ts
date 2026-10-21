import { describe, expect, it } from "vitest";
import {
  createLoginThrottle,
  LOGIN_WINDOW_MS,
  MAX_ATTEMPTS_PER_ACCOUNT,
  MAX_ATTEMPTS_PER_ADDRESS,
} from "./login-throttle";

// What this has to get right is a balance: guessing must become pointless, while the people who
// simply forget their password must keep getting in.

function throttleAt(start = 1_000_000) {
  let clock = start;
  return {
    throttle: createLoginThrottle(() => clock),
    advance(ms: number) {
      clock += ms;
    },
  };
}

const luca = { email: "luca@example.com", address: "203.0.113.7" };

describe("slowing down password guessing", () => {
  it("lets a forgetful person keep trying, up to the limit", () => {
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      expect(throttle.check(luca).allowed).toBe(true);
      throttle.fail(luca);
    }
    const verdict = throttle.check(luca);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfter).toBe(LOGIN_WINDOW_MS / 1_000);
  });

  it("opens again when the window has passed, and says how long that is", () => {
    const { throttle, advance } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      throttle.fail(luca);
    }
    advance(LOGIN_WINDOW_MS / 3);
    expect(throttle.check(luca)).toEqual({ allowed: false, retryAfter: 600 });
    advance(LOGIN_WINDOW_MS);
    expect(throttle.check(luca).allowed).toBe(true);
  });

  it("forgets the failures of someone who then gets the password right", () => {
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT - 1; attempt += 1) {
      throttle.fail(luca);
    }
    throttle.succeed(luca);
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT - 1; attempt += 1) {
      throttle.fail(luca);
    }
    expect(throttle.check(luca).allowed).toBe(true);
  });

  it("counts one mailbox hammered from many addresses", () => {
    // The point of the per-account counter: a botnet gives every guess a fresh address.
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      throttle.fail({ email: luca.email, address: `198.51.100.${attempt}` });
    }
    expect(throttle.check({ email: luca.email, address: "198.51.100.200" }).allowed).toBe(false);
  });

  it("counts one address walking the staff list", () => {
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ADDRESS; attempt += 1) {
      throttle.fail({ email: `person${attempt}@example.com`, address: luca.address });
    }
    expect(throttle.check({ email: "anna@example.com", address: luca.address }).allowed).toBe(
      false,
    );
    // A colleague elsewhere is untouched by it.
    expect(throttle.check({ email: "anna@example.com", address: "192.0.2.9" }).allowed).toBe(true);
  });

  it("gives an office more room than a single account", () => {
    // Everyone in a company shares one public address: ten typos must not shut the door on all.
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT + 5; attempt += 1) {
      throttle.fail(luca);
    }
    expect(throttle.check({ email: "anna@example.com", address: luca.address }).allowed).toBe(true);
  });

  it("reads the same mailbox however it is written", () => {
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      throttle.fail({ email: "  Luca@Example.COM ", address: `198.51.100.${attempt}` });
    }
    expect(throttle.check({ email: "luca@example.com", address: "192.0.2.9" }).allowed).toBe(false);
  });
});
