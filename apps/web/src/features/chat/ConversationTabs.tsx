import type { ConversationListItem } from "@orlok/shared";
import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The size of the buttons on a conversation's tab.
export const TAB_BUTTON = "size-6 rounded-full px-0 [&_svg]:size-3.5";

// The conversations kept open as tabs, per colleague and per browser: every conversation opened
// joins them at the end and stays until its tab is closed.
function storageKey(colleagueId: string) {
  return `orlok-open-conversations:${colleagueId}`;
}

function readOpen(colleagueId: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(colleagueId)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function storeOpen(colleagueId: string, ids: string[]) {
  try {
    localStorage.setItem(storageKey(colleagueId), JSON.stringify(ids));
  } catch {
    // Storage unavailable: the tabs last as long as the page.
  }
}

export function useOpenConversations(
  colleagueId: string,
  conversationId: string | undefined,
  conversations: ConversationListItem[] | undefined,
) {
  const [state, setState] = useState(() => ({ colleagueId, ids: readOpen(colleagueId) }));
  // Another colleague has its own tabs.
  const ids = state.colleagueId === colleagueId ? state.ids : readOpen(colleagueId);

  function update(next: string[]) {
    setState({ colleagueId, ids: next });
    storeOpen(colleagueId, next);
  }

  // Opening a conversation, from the list, a link or the resume, opens its tab. A conversation
  // that no longer exists (deleted elsewhere) loses it; the open one is kept, since a conversation
  // just created is not in the list until the list is fetched again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: update writes what it reads
  useEffect(() => {
    let next = ids;
    if (conversations) {
      const known = new Set(conversations.map((item) => item.id));
      next = next.filter((id) => id === conversationId || known.has(id));
    }
    if (conversationId && !next.includes(conversationId)) {
      next = [...next, conversationId];
    }
    if (next.length !== ids.length || next.some((id, index) => id !== ids[index])) {
      update(next);
    }
  }, [colleagueId, conversationId, conversations]);

  // Closes a tab and says which one takes its place: the one on its right, else on its left.
  function close(id: string): string | undefined {
    const index = ids.indexOf(id);
    const next = ids.filter((item) => item !== id);
    update(next);
    return next[index] ?? next[index - 1];
  }

  // Puts a tab at `index` of the open ones: dragged with the mouse or moved with the keyboard.
  function move(id: string, index: number) {
    const rest = ids.filter((item) => item !== id);
    const next = [...rest.slice(0, index), id, ...rest.slice(index)];
    if (next.some((item, position) => item !== ids[position])) {
      update(next);
    }
  }

  return { ids, close, move };
}

// A conversation not in view with a command or a plan waiting for the person's approval: a red
// dot on its tab. The list of conversations says which ones wait, and keeps itself up to date.
function WaitingDot() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("chat.tabWaiting")}
      title={t("chat.tabWaiting")}
      className="size-2 shrink-0 rounded-full bg-destructive"
    />
  );
}

type ConversationTabsProps = {
  ids: string[];
  conversationId: string | undefined;
  conversations: ConversationListItem[] | undefined;
  // No tab can be chosen or closed: a new conversation is being created.
  disabled: boolean;
  // The open conversation is answering: its tab stays open until the answer ends; the others
  // can be chosen and closed meanwhile (the server goes on writing it, R-CHAT-13).
  busy: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, index: number) => void;
  // The open conversation's own controls (rename, delete), grouped with its close button.
  actions: ReactNode;
};

export function ConversationTabs({
  ids,
  conversationId,
  conversations,
  disabled,
  busy,
  onSelect,
  onClose,
  onMove,
  actions,
}: ConversationTabsProps) {
  const { t } = useTranslation();
  const titles = new Map((conversations ?? []).map((item) => [item.id, item.title]));
  const waiting = new Set(
    (conversations ?? []).filter((item) => item.waiting).map((item) => item.id),
  );
  const tabs = conversationId ? ids : [...ids, ""];
  // The open tab is always in view, also when it was just added at the end of a long strip.
  const stripRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the open tab and the tabs move it
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    const show = () =>
      strip
        .querySelector("[data-tab][data-active]")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    show();
    // The strip changes width with the window, and the open tab with its buttons.
    const observer = new ResizeObserver(show);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [conversationId, tabs.length]);

  // The arrow keys, Home and End move the focus from tab to tab and Enter opens the one in focus,
  // so moving across the strip does not open every conversation on the way. Tab enters the strip
  // on the open tab and leaves it at once.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "tab" || !stripRef.current) {
      return;
    }
    // Ctrl+Shift+arrows move the tab in focus one place, and it keeps the focus.
    const tabId = target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    if (
      tabId &&
      event.ctrlKey &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      const index = ids.indexOf(tabId) + (event.key === "ArrowRight" ? 1 : -1);
      if (index >= 0 && index < ids.length && !disabled) {
        onMove(tabId, index);
        requestAnimationFrame(() => focusTab(tabId));
      }
      return;
    }
    const items = Array.from(
      stripRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    );
    const index = items.indexOf(target as HTMLButtonElement);
    const next =
      event.key === "ArrowRight"
        ? items[(index + 1) % items.length]
        : event.key === "ArrowLeft"
          ? items[(index - 1 + items.length) % items.length]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items[items.length - 1]
              : undefined;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  function focusTab(id: string) {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)
      ?.focus();
  }

  // Dragging a tab with the mouse moves it: past a few pixels a line shows where it would land,
  // and letting go puts it there. Pointer events rather than the browser's drag and drop, which
  // does not start on a button in every browser.
  const drag = useRef<{ id: string; x: number; moving: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  function landing(clientX: number) {
    const tabs = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []);
    for (const element of tabs) {
      const rect = element.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return { id: element.dataset.tabId ?? "", after: false };
      }
    }
    const last = tabs[tabs.length - 1];
    return last ? { id: last.dataset.tabId ?? "", after: true } : null;
  }

  function endDrag() {
    drag.current = null;
    setDragging(null);
    setDropAt(null);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    const id = element.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    // The buttons in the open tab's chip are clicked, not dragged.
    if (event.button !== 0 || disabled || !id || element.closest("[data-tab-chip]")) {
      return;
    }
    drag.current = { id, x: event.clientX, moving: false };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    const strip = stripRef.current;
    if (!current || !strip) {
      return;
    }
    if (!current.moving) {
      if (Math.abs(event.clientX - current.x) < 6) {
        return;
      }
      current.moving = true;
      setDragging(current.id);
      strip.setPointerCapture(event.pointerId);
    }
    setDropAt(landing(event.clientX));
    // Near an edge of a long strip, it scrolls to show the tabs beyond.
    const rect = strip.getBoundingClientRect();
    if (event.clientX < rect.left + 40) {
      strip.scrollLeft -= 12;
    } else if (event.clientX > rect.right - 40) {
      strip.scrollLeft += 12;
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.moving) {
      const target = landing(event.clientX);
      if (target && target.id !== current.id) {
        const rest = ids.filter((item) => item !== current.id);
        onMove(current.id, rest.indexOf(target.id) + (target.after ? 1 : 0));
      }
    }
    endDrag();
  }

  return (
    <div className="border-b px-2 sm:px-4">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t("chat.tabs")}
        className={cn(
          "strip-scrollbar flex items-end gap-1 overflow-x-auto pt-1 select-none",
          dragging && "cursor-grabbing",
        )}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
      >
        {tabs.map((id) => {
          const active = id === (conversationId ?? "");
          // Until the list arrives the titles are not known yet: an ellipsis, not "Untitled".
          const title = !id
            ? t("chat.newConversation")
            : conversations
              ? (titles.get(id) ?? t("chat.untitled"))
              : "…";
          return (
            <div
              key={id || "new"}
              data-tab
              data-tab-id={id || undefined}
              data-active={active || undefined}
              className={cn(
                "relative flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-2 py-1 text-sm",
                dragging === id && "opacity-50",
                active
                  ? "border-primary font-medium"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                disabled={disabled && !active}
                title={title}
                className="max-w-56 truncate py-0.5 disabled:opacity-60"
                onClick={() => {
                  if (!active && id) {
                    onSelect(id);
                  }
                }}
              >
                {title}
              </button>
              {dropAt && dragging && dropAt.id === id && dragging !== id ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-1 w-0.5 rounded bg-primary",
                    dropAt.after ? "-right-1" : "-left-1",
                  )}
                />
              ) : null}
              {id && !active && waiting.has(id) ? <WaitingDot /> : null}
              {id ? (
                <span
                  data-tab-chip
                  className={cn(
                    "flex items-center",
                    active && "ml-1.5 rounded-full border bg-muted/40 px-0.5",
                  )}
                >
                  {active ? actions : null}
                  {/* Only the open tab's close button is on the Tab path, so Tab leaves the strip. */}
                  <button
                    type="button"
                    tabIndex={active ? 0 : -1}
                    disabled={disabled || (busy && active)}
                    aria-label={t("chat.closeTab", { title })}
                    title={t("chat.closeTab", { title })}
                    className={cn(buttonClasses("ghost", "sm"), TAB_BUTTON)}
                    onClick={() => onClose(id)}
                  >
                    <X aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
