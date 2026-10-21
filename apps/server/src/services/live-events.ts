import type { LiveEvent } from "@orlok/shared";

// Tells a person's open pages that something changed elsewhere: an answer started or ended
// from Telegram or after an approval, a conversation created, renamed or deleted in another tab
// or chat (R-CHAT-13). Pages refresh what they show; nothing else rides on these events.
//
// Kept in memory: there is one server process, and a page reconnecting after a restart reloads.

type Listener = (event: LiveEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export const liveEvents = {
  subscribe(userId: string, listener: Listener) {
    let set = listeners.get(userId);
    if (!set) {
      set = new Set();
      listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(userId);
      }
    };
  },
  publish(userId: string, event: LiveEvent) {
    for (const listener of listeners.get(userId) ?? []) {
      try {
        listener(event);
      } catch {
        // One page failing does not stop the others.
      }
    }
  },
};

export function conversationChanged(
  userId: string,
  colleagueId: string,
  conversationId: string | null,
  deleted = false,
) {
  liveEvents.publish(userId, {
    type: "conversation",
    colleagueId,
    conversationId,
    ...(deleted ? { deleted } : {}),
  });
}
