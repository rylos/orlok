import { LOCALE_NAMES, SUPPORTED_LOCALES, THEMES, type ThemePreference } from "@orlok/shared";
import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type NavigateOptions, useMatch, useNavigate } from "react-router";
import { useChooseLocale, useChooseTheme, useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWikiOverview, useWikiSearch } from "@/lib/wiki-queries";
import {
  colleagueSettingsPath,
  useConversations,
  useWorkspaceOffices,
} from "@/lib/workspace-queries";

// The palette opens from anywhere with Ctrl+K (⌘K on a Mac) or from the search button in the
// header, which sends this event. AltGr is Ctrl+Alt on Windows, so a combination with Alt is
// left to the keyboard: on an Italian layout it types @, # and the brackets.
const OPEN_EVENT = "orlok:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Where the focus was, to go back there when the palette closes without opening anything.
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = () => {
      returnRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (isMac ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        if (dialogRef.current?.open) {
          dialogRef.current.close();
        } else {
          show();
        }
      }
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is on the backdrop; Esc closes it from the keyboard
    <dialog
      ref={dialogRef}
      // Esc and a click outside close it like the close() of an item does.
      onClose={() => {
        setOpen(false);
        returnRef.current?.focus();
        returnRef.current = null;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.close();
        }
      }}
      className="fixed inset-x-0 top-[12vh] mx-auto my-0 w-[min(36rem,calc(100%-2rem))] rounded-lg border bg-popover p-0 text-popover-foreground shadow-xl backdrop:bg-black/40"
    >
      {open ? (
        <PaletteBody
          onDone={(run) => {
            // Opening something moves the focus there: nothing to go back to.
            returnRef.current = null;
            dialogRef.current?.close();
            run();
          }}
        />
      ) : null}
    </dialog>
  );
}

type Group = "actions" | "colleagues" | "conversations" | "wiki";

type Item = {
  id: string;
  group: Group;
  label: string;
  hint?: string;
  // More words it is found by, besides the label.
  keywords?: string;
  run: () => void;
};

// Case and accents do not count: "citta" finds "Città".
function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function matches(item: Item, words: string[]) {
  const text = normalize(`${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`);
  return words.every((word) => text.includes(word));
}

// Searching the wiki at every key would ask the server for every letter.
function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const ADMIN_SECTIONS = [
  { to: "offices", labelKey: "nav.offices" },
  { to: "people", labelKey: "nav.people" },
  { to: "profiles", labelKey: "nav.profiles" },
  { to: "hosts", labelKey: "nav.hosts" },
  { to: "models", labelKey: "nav.models" },
  { to: "costs", labelKey: "nav.costs" },
  { to: "email", labelKey: "nav.email" },
  { to: "operations", labelKey: "ops.nav" },
] as const;

function PaletteBody({ onDone }: { onDone: (run: () => void) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listId = useId();
  const { data: me } = useMe();
  const offices = useWorkspaceOffices();
  const chooseTheme = useChooseTheme();
  const chooseLocale = useChooseLocale();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Where the person is: the colleague open in the chat, and its office or the wiki's office.
  const colleagueMatch = useMatch("/colleagues/:colleagueId/*");
  const officeMatch = useMatch("/offices/:officeId/*");
  const colleagueId = colleagueMatch?.params.colleagueId;
  const officeList = offices.data ?? [];
  const colleagueOffice = colleagueId
    ? officeList.find((office) => office.colleagues.some((item) => item.id === colleagueId))
    : undefined;
  const colleague = colleagueOffice?.colleagues.find((item) => item.id === colleagueId);
  const officeId = officeMatch?.params.officeId ?? colleagueOffice?.id;
  const office = officeList.find((item) => item.id === officeId);

  const conversations = useConversations(colleague?.id ?? "", colleague !== undefined);
  const overview = useWikiOverview(office?.id ?? "", office !== undefined);
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const searched = useDebounced(query.trim(), 200);
  const wikiSearch = useWikiSearch(office?.id ?? "", office ? searched : "");

  const go = (to: string, options?: NavigateOptions) => () => navigate(to, options);
  const items: Item[] = [];

  // Actions: first those of the colleague and the office in view.
  if (colleague) {
    items.push({
      id: "new-conversation",
      group: "actions",
      label: t("palette.newConversationWith", { name: colleague.name }),
      run: go(`/colleagues/${colleague.id}`, { state: { fresh: true } }),
    });
    const settings = colleagueSettingsPath(
      colleague,
      colleagueOffice?.id ?? "",
      me?.role === "admin",
    );
    if (settings) {
      items.push({
        id: "colleague-settings",
        group: "actions",
        label: t("colleagues.settingsOf", { name: colleague.name }),
        run: go(settings),
      });
    }
  }
  if (office) {
    const base = `/offices/${office.id}/wiki`;
    const inOffice = (action: string) => t("palette.inOffice", { action, office: office.name });
    if (overview.data?.canEdit) {
      items.push({
        id: "wiki-new",
        group: "actions",
        label: inOffice(t("wiki.newPage")),
        keywords: "wiki",
        run: go(`${base}/_new`),
      });
    }
    items.push(
      {
        id: "wiki-review",
        group: "actions",
        label: inOffice(t("wiki.reviewLink")),
        keywords: "wiki",
        run: go(`${base}/_review`),
      },
      {
        id: "wiki-graph",
        group: "actions",
        label: inOffice(t("wiki.graphLink")),
        keywords: "wiki",
        run: go(`${base}/_graph`),
      },
      {
        id: "wiki-log",
        group: "actions",
        label: inOffice(t("wiki.log")),
        keywords: "wiki",
        run: go(`${base}/_log`),
      },
    );
  }
  for (const item of officeList) {
    items.push({
      id: `wiki-${item.id}`,
      group: "actions",
      label: t("palette.wikiOf", { office: item.name }),
      run: go(`/offices/${item.id}/wiki`),
    });
  }
  items.push(
    { id: "home", group: "actions", label: t("nav.workspace"), run: go("/") },
    { id: "account", group: "actions", label: t("nav.account"), run: go("/account") },
  );
  if (me?.role === "admin") {
    for (const section of ADMIN_SECTIONS) {
      items.push({
        id: `admin-${section.to}`,
        group: "actions",
        label: t("palette.admin", { section: t(section.labelKey) }),
        run: go(`/admin/${section.to}`),
      });
    }
  }
  const themes: { id: ThemePreference; label: string }[] = [
    { id: "system", label: t("theme.system") },
    ...THEMES.map((theme) => ({ id: theme.id, label: theme.label })),
  ];
  for (const theme of themes) {
    items.push({
      id: `theme-${theme.id}`,
      group: "actions",
      label: t("palette.theme", { name: theme.label }),
      run: () => chooseTheme(theme.id),
    });
  }
  for (const locale of SUPPORTED_LOCALES) {
    items.push({
      id: `locale-${locale}`,
      group: "actions",
      label: t("palette.language", { name: LOCALE_NAMES[locale] }),
      run: () => chooseLocale(locale),
    });
  }

  for (const item of officeList) {
    for (const person of item.colleagues) {
      items.push({
        id: `colleague-${person.id}`,
        group: "colleagues",
        label: person.name,
        hint: `${person.title} · ${item.name}`,
        run: go(`/colleagues/${person.id}`),
      });
    }
  }

  if (colleague) {
    for (const conversation of conversations.data ?? []) {
      items.push({
        id: `conversation-${conversation.id}`,
        group: "conversations",
        label: conversation.title ?? t("chat.untitled"),
        hint: colleague.name,
        run: go(`/colleagues/${colleague.id}/${conversation.id}`),
      });
    }
  }

  // Wiki pages: those whose title matches at once, then what the server finds in the text.
  const wikiPages = new Map<string, Item>();
  if (office && words.length > 0) {
    const toItem = (page: { slug: string; title: string }, hint?: string): Item => ({
      id: `wiki-page-${page.slug}`,
      group: "wiki",
      label: page.title,
      hint: hint ?? office.name,
      keywords: page.slug,
      run: go(`/offices/${office.id}/wiki/${page.slug}`),
    });
    for (const page of overview.data?.pages ?? []) {
      const item = toItem(page);
      if (matches(item, words)) {
        wikiPages.set(page.slug, item);
      }
    }
    if (searched === query.trim()) {
      for (const page of wikiSearch.data ?? []) {
        if (!wikiPages.has(page.slug)) {
          wikiPages.set(page.slug, toItem(page));
        }
      }
    }
  }

  // With nothing written: the actions of where the person is, the colleagues and the
  // conversations. Writing searches everything; each group shows its first few.
  const LIMIT = { actions: words.length ? 8 : 6, colleagues: 6, conversations: 6, wiki: 8 };
  const found = [
    ...items.filter((item) => words.length === 0 || matches(item, words)),
    ...wikiPages.values(),
  ];
  const groups: Group[] = ["actions", "colleagues", "conversations", "wiki"];
  const shown = groups.flatMap((group) =>
    found.filter((item) => item.group === group).slice(0, LIMIT[group]),
  );
  const active = Math.min(index, Math.max(shown.length - 1, 0));

  // The chosen item stays in view as the arrows move through a long list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chosen item moves it
  useEffect(() => {
    listRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((active + step + shown.length) % shown.length);
      }
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const item = shown[active];
      if (item) {
        onDone(item.run);
      }
    }
  }

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be written in
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={shown[active] ? `${listId}-${shown[active].id}` : undefined}
          aria-label={t("palette.open")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div ref={listRef} id={listId} role="listbox" className="min-h-0 overflow-y-auto p-1">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {offices.isPending || (searched !== query.trim() && office) ? "…" : t("palette.empty")}
          </p>
        ) : null}
        {groups.map((group) => {
          const inGroup = shown.filter((item) => item.group === group);
          if (inGroup.length === 0) {
            return null;
          }
          return (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox
            <div key={group} role="group" aria-label={t(`palette.groups.${group}`)}>
              <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {t(`palette.groups.${group}`)}
              </p>
              {inGroup.map((item) => {
                const position = shown.indexOf(item);
                const selected = position === active;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are handled by the search field
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseMove={() => setIndex(position)}
                    onClick={() => onDone(item.run)}
                    className={cn(
                      "flex cursor-pointer items-baseline gap-2 rounded-md px-3 py-2 text-sm",
                      selected && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="truncate text-xs text-muted-foreground">{item.hint}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t("palette.hint")}</p>
    </div>
  );
}
