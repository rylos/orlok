import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

// Slowing down password guessing (R-SEC-7). An installation is meant to be reachable from the
// internet, so the login page is the one door anybody can knock on: without a brake, a list of
// common passwords is tried at the speed of the network.
//
// Two counters, because one alone is not enough. Per account, or a single mailbox is hammered
// from a botnet. Per address, or one machine walks the whole staff list. The office limit is the
// looser of the two on purpose: a company shares one public address, and everybody there must not
// be locked out because one colleague mistyped their password ten times.

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_ATTEMPTS_PER_ACCOUNT = 10;
export const MAX_ATTEMPTS_PER_ADDRESS = 50;
// A cap on what a flood of addresses can make us remember. Pruning usually keeps us far below it.
const MAX_TRACKED = 20_000;

export type LoginAttempt = { email: string; address: string };
export type ThrottleVerdict = { allowed: boolean; retryAfter: number };

type Bucket = { count: number; startedAt: number };

export type LoginThrottle = {
  check(attempt: LoginAttempt): ThrottleVerdict;
  fail(attempt: LoginAttempt): void;
  succeed(attempt: LoginAttempt): void;
};

// The clock is injected so the tests can watch a window close without waiting a quarter of an hour.
export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const buckets = new Map<string, Bucket>();

  const keysOf = (attempt: LoginAttempt) => [
    `account:${attempt.email.trim().toLowerCase()}`,
    `address:${attempt.address}`,
  ];
  const limitOf = (key: string) =>
    key.startsWith("account:") ? MAX_ATTEMPTS_PER_ACCOUNT : MAX_ATTEMPTS_PER_ADDRESS;
  const live = (bucket: Bucket, at: number) => at - bucket.startedAt < LOGIN_WINDOW_MS;

  function prune(at: number) {
    for (const [key, bucket] of buckets) {
      if (!live(bucket, at)) {
        buckets.delete(key);
      }
    }
    // Still full after pruning: drop the oldest, which is the closest to expiring anyway.
    while (buckets.size >= MAX_TRACKED) {
      const oldest = [...buckets].reduce((a, b) => (a[1].startedAt <= b[1].startedAt ? a : b));
      buckets.delete(oldest[0]);
    }
  }

  return {
    check(attempt) {
      const at = now();
      let retryAfter = 0;
      for (const key of keysOf(attempt)) {
        const bucket = buckets.get(key);
        if (bucket && live(bucket, at) && bucket.count >= limitOf(key)) {
          const left = Math.ceil((bucket.startedAt + LOGIN_WINDOW_MS - at) / 1_000);
          retryAfter = Math.max(retryAfter, left);
        }
      }
      return { allowed: retryAfter === 0, retryAfter };
    },

    fail(attempt) {
      const at = now();
      prune(at);
      for (const key of keysOf(attempt)) {
        const bucket = buckets.get(key);
        if (bucket && live(bucket, at)) {
          bucket.count += 1;
        } else {
          buckets.set(key, { count: 1, startedAt: at });
        }
      }
    },

    // A password that works says the attempts before it were a person being forgetful, not an
    // attack. It also lets a colleague who finally got in unblock the address for the office.
    succeed(attempt) {
      for (const key of keysOf(attempt)) {
        buckets.delete(key);
      }
    },
  };
}

// Who is knocking. Behind the reverse proxy the socket is the proxy itself, so the address comes
// from X-Forwarded-For — the *last* entry, the only one a client cannot forge: nginx appends the
// address it sees to whatever the request carried.
export function clientAddress(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  const nearest = forwarded
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (nearest) {
    return nearest;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No socket behind this request (tests, or a runtime that does not expose one).
    return "unknown";
  }
}
