import type { ChatStreamEvent, ErrorCode } from "@orlok/shared";

// The answers colleagues are writing right now, one per conversation at most (R-CHAT-13).
//
// A turn used to live inside the request that asked for it: close the tab, reload the page, lose
// the network for a moment, and the colleague stopped halfway through, with a wiki page half
// written. Now the turn belongs to the server. The page that asked only watches it, and so can any
// page opened later, which is shown everything said so far and then the rest as it comes. Only
// someone pressing Stop ends a turn early.
//
// Kept in memory: there is one server process, and a restart ends every turn anyway.

export type TurnListener = {
  event: (event: ChatStreamEvent) => void;
  end: () => void;
};

export type TurnRunner = (
  signal: AbortSignal,
  send: (event: ChatStreamEvent) => Promise<void>,
) => Promise<unknown>;

type RunningTurn = {
  controller: AbortController;
  events: ChatStreamEvent[];
  listeners: Set<TurnListener>;
  done: Promise<void>;
  resolveDone: () => void;
};

// A conversation claimed for a turn: nothing else can start in it until the turn ends, or until
// the claim is released because the request failed before the turn could start.
export type TurnClaim = {
  run(runner: TurnRunner): Promise<void>;
  release(): void;
};

export type TurnRegistry = {
  isRunning(conversationId: string): boolean;
  claim(conversationId: string): TurnClaim | null;
  // Replays what the turn has said so far, then passes on the rest. Null when nothing is running.
  follow(conversationId: string, listener: TurnListener): (() => void) | null;
  stop(conversationId: string): boolean;
  // Resolves once the conversation has no turn running.
  idle(conversationId: string): Promise<void>;
};

// Said to whoever watches when the turn broke on something no answer can explain.
const CRASHED: { code: ErrorCode; message: string } = {
  code: "internal_error",
  message: "The answer failed unexpectedly",
};

export function createTurnRegistry(): TurnRegistry {
  const turns = new Map<string, RunningTurn>();

  function record(turn: RunningTurn, event: ChatStreamEvent) {
    // An answer arrives a few characters at a time: kept as one piece, so a page opened late
    // replays a paragraph instead of a thousand fragments.
    const last = turn.events.at(-1);
    if (event.type === "text" && last?.type === "text") {
      turn.events[turn.events.length - 1] = { type: "text", text: last.text + event.text };
    } else {
      turn.events.push(event);
    }
  }

  return {
    isRunning(conversationId) {
      return turns.has(conversationId);
    },

    claim(conversationId) {
      if (turns.has(conversationId)) {
        return null;
      }
      let resolveDone = () => {};
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const turn: RunningTurn = {
        controller: new AbortController(),
        events: [],
        listeners: new Set(),
        done,
        resolveDone,
      };
      turns.set(conversationId, turn);

      function finish() {
        if (turns.get(conversationId) !== turn) {
          return;
        }
        turns.delete(conversationId);
        for (const listener of turn.listeners) {
          listener.end();
        }
        turn.listeners.clear();
        turn.resolveDone();
      }

      return {
        async run(runner) {
          const send = async (event: ChatStreamEvent) => {
            record(turn, event);
            for (const listener of turn.listeners) {
              listener.event(event);
            }
          };
          try {
            await runner(turn.controller.signal, send);
          } catch (error) {
            console.error("Colleague turn failed", error);
            await send({ type: "error", ...CRASHED });
          } finally {
            finish();
          }
        },
        release: finish,
      };
    },

    follow(conversationId, listener) {
      const turn = turns.get(conversationId);
      if (!turn) {
        return null;
      }
      for (const event of turn.events) {
        listener.event(event);
      }
      turn.listeners.add(listener);
      return () => {
        turn.listeners.delete(listener);
      };
    },

    stop(conversationId) {
      const turn = turns.get(conversationId);
      if (!turn) {
        return false;
      }
      turn.controller.abort();
      return true;
    },

    async idle(conversationId) {
      for (;;) {
        const turn = turns.get(conversationId);
        if (!turn) {
          return;
        }
        await turn.done;
      }
    },
  };
}

// The one registry of this server process.
export const runningTurns = createTurnRegistry();
