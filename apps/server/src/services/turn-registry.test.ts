import type { ChatStreamEvent } from "@orlok/shared";
import { describe, expect, it } from "vitest";
import { createTurnRegistry } from "./turn-registry";

// The promise that a person can close the page without losing the answer rests on this: the turn
// outlives whoever watches it, anyone can pick it up where it is, and only Stop ends it.

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function watcher() {
  const events: ChatStreamEvent[] = [];
  let ended = false;
  return {
    events,
    get ended() {
      return ended;
    },
    listener: {
      event: (event: ChatStreamEvent) => events.push(event),
      end: () => {
        ended = true;
      },
    },
  };
}

describe("answers that belong to the server", () => {
  it("allows one answer at a time in a conversation, and frees it when the answer ends", async () => {
    const turns = createTurnRegistry();
    const claim = turns.claim("c1");
    expect(claim).not.toBeNull();
    expect(turns.claim("c1")).toBeNull();
    // Other conversations are not held up by it.
    expect(turns.claim("c2")).not.toBeNull();

    await claim?.run(async () => {});
    expect(turns.isRunning("c1")).toBe(false);
    expect(turns.claim("c1")).not.toBeNull();
  });

  it("frees the conversation when the request fails before the answer starts", () => {
    const turns = createTurnRegistry();
    turns.claim("c1")?.release();
    expect(turns.isRunning("c1")).toBe(false);
  });

  it("keeps writing when nobody is watching any more", async () => {
    const turns = createTurnRegistry();
    const claim = turns.claim("c1");
    const paused = gate();
    let finished = false;
    const running = claim?.run(async (_signal, send) => {
      await send({ type: "text", text: "Prima " });
      await paused.opened;
      await send({ type: "text", text: "e dopo." });
      finished = true;
    });

    const page = watcher();
    const unfollow = turns.follow("c1", page.listener);
    unfollow?.();
    paused.open();
    await running;

    expect(finished).toBe(true);
    // The page that left saw only what came before it left.
    expect(page.events).toEqual([{ type: "text", text: "Prima " }]);
  });

  it("shows a page opened late everything said so far, in one piece, then the rest", async () => {
    const turns = createTurnRegistry();
    const claim = turns.claim("c1");
    const paused = gate();
    const reached = gate();
    const running = claim?.run(async (_signal, send) => {
      await send({ type: "context", pages: [{ slug: "npm", title: "NPM" }] });
      for (const piece of ["Con", "trol", "lo."]) {
        await send({ type: "text", text: piece });
      }
      reached.open();
      await paused.opened;
      await send({ type: "tool", name: "wiki_write" });
    });

    await reached.opened;
    const late = watcher();
    turns.follow("c1", late.listener);
    expect(late.events).toEqual([
      { type: "context", pages: [{ slug: "npm", title: "NPM" }] },
      { type: "text", text: "Controllo." },
    ]);

    paused.open();
    await running;
    expect(late.events.at(-1)).toEqual({ type: "tool", name: "wiki_write" });
    expect(late.ended).toBe(true);
  });

  it("stops only when asked", async () => {
    const turns = createTurnRegistry();
    const claim = turns.claim("c1");
    let aborted = false;
    const running = claim?.run(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    );
    expect(turns.stop("c1")).toBe(true);
    await running;
    expect(aborted).toBe(true);
    expect(turns.stop("c1")).toBe(false);
  });

  it("tells whoever watches when an answer breaks, and frees the conversation", async () => {
    const turns = createTurnRegistry();
    const claim = turns.claim("c1");
    const page = watcher();
    turns.follow("c1", page.listener);
    const quiet = console.error;
    console.error = () => {};
    try {
      await claim?.run(async () => {
        throw new Error("database gone");
      });
    } finally {
      console.error = quiet;
    }
    expect(page.events.at(-1)).toMatchObject({ type: "error", code: "internal_error" });
    expect(page.ended).toBe(true);
    expect(turns.isRunning("c1")).toBe(false);
  });

  it("lets a waiting answer go once the one before it has ended", async () => {
    const turns = createTurnRegistry();
    const first = turns.claim("c1");
    const paused = gate();
    const running = first?.run(() => paused.opened);

    let waited = false;
    const next = turns.idle("c1").then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);

    paused.open();
    await running;
    await next;
    expect(waited).toBe(true);
  });
});
