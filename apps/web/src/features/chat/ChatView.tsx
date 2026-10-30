import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENTS_MAX,
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_IMAGE_EXTENSIONS,
  type ChatAttachment,
  type ChatStreamEvent,
  type ConversationSummary,
  type MessagePart,
  type OpsJob,
  type WikiEdit,
  type WikiPageRef,
  type WorkspaceColleague,
  type WorkspaceOffice,
} from "@orlok/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Ellipsis,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  TriangleAlert,
  UsersRound,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError } from "@/i18n/errors";
import { HeaderActions } from "@/layouts/HeaderActions";
import { ApiRequestError, apiFetch, apiUpload, followApi, streamApi } from "@/lib/api";
import { useArchiveColleague } from "@/lib/colleague-queries";
import { setStreamingConversation } from "@/lib/live-events";
import { isJobUnderway, opsKeys, useConversationJobs } from "@/lib/ops-queries";
import { useMe } from "@/lib/queries";
import { cn, localId } from "@/lib/utils";
import {
  colleagueSettingsPath,
  useConversation,
  useConversations,
  useDeleteConversation,
  workspaceKeys,
} from "@/lib/workspace-queries";
import { ApprovalDock } from "./ApprovalDock";
import { ContextMeter } from "./ContextMeter";
import { ConversationTabs, TAB_BUTTON, useOpenConversations } from "./ConversationTabs";
import { type DisplayAttachment, MessageBubble } from "./MessageBubble";
import { RenameConversation } from "./RenameConversation";
import { StoredMessage } from "./StoredMessage";
import { WikiCandidates } from "./WikiCandidates";

type ChatViewProps = {
  office: WorkspaceOffice;
  colleague: WorkspaceColleague;
  // Archived colleagues keep their conversations readable but do not answer.
  archived: boolean;
  conversationId: string | undefined;
};

// Message being exchanged: shown until the stored conversation is reloaded. The answer is kept
// as the parts it is made of, in the order the stream delivers them (R-CHAT-4), which is the
// same shape the server stores.
type Pending = {
  content: string;
  // Picked up while already running: the question is already among the stored messages.
  resumed: boolean;
  // When the answer began, and the last time anything arrived from it (ms).
  startedAt: number;
  lastEventAt: number;
  parts: MessagePart[];
  streamError: string | null;
  // Pages given before answering (their titles name the links of the answer) and those used.
  wikiContext: WikiPageRef[];
  wikiPages: WikiPageRef[];
  wikiEdits: WikiEdit[];
  activity: string | null;
  jobs: OpsJob[];
  attachments: DisplayAttachment[];
};

// File chosen for the next message: uploaded (and read) right away.
type DraftAttachment = {
  key: string;
  fileName: string;
  kind: ChatAttachment["kind"];
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  attachment?: ChatAttachment;
  error?: string;
};

// A message written while the colleague is still answering. The server takes one message at a
// time, so it waits in the page and goes with the others queued, as one message, once the answer
// has ended. Kept per conversation: one queued in a tab left meanwhile goes when it is opened again.
type QueuedMessage = {
  key: string;
  content: string;
  attachments: DraftAttachment[];
};

// The queue of a conversation that its first message is still creating.
const NEW_CONVERSATION = "";

function joinMessages(...contents: string[]) {
  return contents.filter((content) => content.trim() !== "").join("\n\n");
}

function withoutQueue(queues: Record<string, QueuedMessage[]>, key: string) {
  const rest = { ...queues };
  delete rest[key];
  return rest;
}

const ACCEPTED_EXTENSIONS: readonly string[] = [
  ...CHAT_IMAGE_EXTENSIONS,
  ...CHAT_DOCUMENT_EXTENSIONS,
];
const ACCEPT = ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",");

const PASTED_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Files in the clipboard: from `files`, or from file items (some browsers and desktops expose
// screenshots only there). Pasted images get a name matching their type.
function clipboardFiles(data: DataTransfer): File[] {
  const found = data.files.length > 0 ? [...data.files] : [];
  if (found.length === 0) {
    for (const item of data.items) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) {
        found.push(file);
      }
    }
  }
  return found.map((file, index) => {
    const extension = PASTED_EXTENSIONS[file.type];
    if (!extension || ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
      return file;
    }
    const suffix = found.length > 1 ? `-${index + 1}` : "";
    return new File([file], `pasted-image${suffix}.${extension}`, { type: file.type });
  });
}

function extensionOf(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

// Reading width and alignment of the conversation, remembered per browser (R-UI-6).
const CHAT_WIDTHS = ["narrow", "wide", "full"] as const;
type ChatWidth = (typeof CHAT_WIDTHS)[number];
const CHAT_WIDTH_KEY = "orlok-chat-width";
const WIDTH_CLASSES: Record<ChatWidth, string> = {
  narrow: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
};

const CHAT_ALIGNS = ["center", "left"] as const;
type ChatAlign = (typeof CHAT_ALIGNS)[number];
const CHAT_ALIGN_KEY = "orlok-chat-align";
const ALIGN_CLASSES: Record<ChatAlign, string> = {
  center: "mx-auto",
  left: "mr-auto",
};

function readStored<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return values.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice applies to this page only.
  }
}

// The colleague is writing: the text joins the part it is still writing.
function withText(parts: MessagePart[], text: string): MessagePart[] {
  const last = parts.at(-1);
  if (last?.type === "text") {
    return [...parts.slice(0, -1), { type: "text", text: last.text + text }];
  }
  // The blank line that follows a command belongs to the answer, not to the text after the card.
  const started = text.replace(/^\s+/, "");
  return started === "" ? parts : [...parts, { type: "text", text: started }];
}

// A command was born: it takes its place in the answer, and its later updates leave it there.
function withJob(parts: MessagePart[], jobId: string): MessagePart[] {
  return parts.some((part) => part.type === "job" && part.jobId === jobId)
    ? parts
    : [...parts, { type: "job", jobId }];
}

// Wide enough for the conversations' tabs; on a phone the list alone picks the conversation.
const TABS_MEDIA = "(min-width: 768px)";

function useTabsShown() {
  const [shown, setShown] = useState(
    () => typeof window !== "undefined" && window.matchMedia(TABS_MEDIA).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(TABS_MEDIA);
    const onChange = () => setShown(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return shown;
}

// A touch screen without a mouse: a phone or a tablet, where the keyboard has no Shift+Enter.
function isTouchOnly() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
}

export function ChatView({ office, colleague, archived, conversationId }: ChatViewProps) {
  const { t, i18n } = useTranslation();
  const [touch] = useState(isTouchOnly);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const conversations = useConversations(colleague.id);
  const { data: me } = useMe();
  // Who may give the colleague a profile is told it needs one; the others that it is unavailable.
  const settingsPath = colleagueSettingsPath(colleague, office.id, me?.role === "admin");
  // The conversation whose title is being edited, from its menu.
  const [renaming, setRenaming] = useState<string | null>(null);
  const waitingCount = (conversations.data ?? []).filter((item) => item.waiting).length;
  const conversation = useConversation(conversationId);
  const conversationJobs = useConversationJobs(office.id, conversationId);
  // Opening a colleague resumes the conversation last opened with it in this browser (else the
  // most recently updated); "New conversation" navigates with state `fresh` (R-CHAT-2).
  const startFresh = (location.state as { fresh?: boolean } | null)?.fresh === true;
  const lastOpenedKey = `orlok-last-conversation:${colleague.id}`;
  useEffect(() => {
    if (conversationId) {
      try {
        localStorage.setItem(lastOpenedKey, conversationId);
      } catch {
        // Storage unavailable: fall back to the most recent conversation.
      }
    }
  }, [conversationId, lastOpenedKey]);
  const resumeConversationId = (() => {
    const list = conversations.data ?? [];
    let lastOpened: string | null = null;
    try {
      lastOpened = localStorage.getItem(lastOpenedKey);
    } catch {
      lastOpened = null;
    }
    if (lastOpened && list.some((item) => item.id === lastOpened)) {
      return lastOpened;
    }
    return list.reduce<ConversationSummary | null>(
      (latest, item) => (!latest || item.updatedAt > latest.updatedAt ? item : latest),
      null,
    )?.id;
  })();
  useEffect(() => {
    if (!conversationId && !startFresh && resumeConversationId) {
      navigate(`/colleagues/${colleague.id}/${resumeConversationId}`, { replace: true });
    }
  }, [conversationId, startFresh, resumeConversationId, colleague.id, navigate]);
  // Queued or running: a command only waiting for a decision changes nothing until it is
  // decided, and the decision arrives as a live event.
  const activeJobs = conversationJobs.data?.some(isJobUnderway) ?? false;
  // A command approved after the answer ended makes the colleague answer again: keep the
  // conversation fresh while commands are active and for a while after they end. The refreshes
  // name the conversation they belong to, so the ones still pending after leaving it do nothing
  // instead of asking the server for a conversation that is no longer open.
  useEffect(() => {
    if (!activeJobs || !conversationId) {
      return;
    }
    const refresh = () =>
      void queryClient.refetchQueries({ queryKey: workspaceKeys.conversation(conversationId) });
    const interval = window.setInterval(refresh, 4_000);
    return () => {
      window.clearInterval(interval);
      for (const delay of [5_000, 15_000, 40_000]) {
        window.setTimeout(refresh, delay);
      }
    };
  }, [activeJobs, conversationId, queryClient]);
  const deleteConversation = useDeleteConversation(colleague.id);
  const tabsShown = useTabsShown();
  const openTabs = useOpenConversations(colleague.id, conversationId, conversations.data);
  const restore = useArchiveColleague();
  const [draft, setDraft] = useState("");
  // Another page can open a conversation with a request already written (the wiki review asks a
  // colleague to fix an item): the person reads it, adds to it and sends it.
  const suggested = (location.state as { draft?: string } | null)?.draft;
  useEffect(() => {
    if (suggested) {
      setDraft(suggested);
    }
  }, [suggested]);
  // The message box grows with what is written or put there (a request from the wiki review is
  // several lines), up to its max-h-60, then scrolls.
  const messageRef = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(() => {
    const box = messageRef.current;
    if (!box) {
      return;
    }
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [draft]);
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState<ChatWidth>(() =>
    readStored(CHAT_WIDTH_KEY, CHAT_WIDTHS, "narrow"),
  );
  const [align, setAlign] = useState<ChatAlign>(() =>
    readStored(CHAT_ALIGN_KEY, CHAT_ALIGNS, "center"),
  );
  const layoutClass = cn(WIDTH_CLASSES[width], ALIGN_CLASSES[align]);

  function updateDraft(key: string, patch: Partial<DraftAttachment>) {
    setDrafts((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function addFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setRequestError(null);
    const room = CHAT_ATTACHMENTS_MAX - drafts.length;
    if (files.length > room) {
      setRequestError(t("chat.attachments.tooMany", { max: CHAT_ATTACHMENTS_MAX }));
    }
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = localId();
      const fileName = file.name || "image.png";
      const extension = extensionOf(fileName);
      const kind = (CHAT_IMAGE_EXTENSIONS as readonly string[]).includes(extension)
        ? "image"
        : "document";
      const problem = !ACCEPTED_EXTENSIONS.includes(extension)
        ? t("errors.codes.unsupported_file")
        : file.size > CHAT_ATTACHMENT_MAX_BYTES
          ? t("errors.codes.file_too_large")
          : null;
      const previewUrl = kind === "image" && !problem ? URL.createObjectURL(file) : null;
      setDrafts((current) => [
        ...current,
        {
          key,
          fileName,
          kind,
          previewUrl,
          status: problem ? "error" : "uploading",
          error: problem ?? undefined,
        },
      ]);
      if (problem) {
        continue;
      }
      const form = new FormData();
      form.append("colleagueId", colleague.id);
      form.append("file", file, fileName);
      apiUpload<ChatAttachment>("/attachments", form)
        .then((attachment) => updateDraft(key, { status: "ready", attachment }))
        .catch((error: unknown) =>
          updateDraft(key, { status: "error", error: translateError(t, error) }),
        );
    }
  }

  function releaseAttachment(item: DraftAttachment) {
    if (item.attachment) {
      void apiFetch(`/attachments/${item.attachment.id}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    }
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }

  function removeDraft(item: DraftAttachment) {
    releaseAttachment(item);
    setDrafts((current) => current.filter((draftItem) => draftItem.key !== item.key));
  }

  // Pasted images (screenshots) often come only as clipboard items, without a usable name.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    function onPaste(event: globalThis.ClipboardEvent) {
      const target = event.target;
      const typingElsewhere =
        target instanceof HTMLElement &&
        target.id !== "chat-message" &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (!event.clipboardData || typingElsewhere) {
        return;
      }
      const files = clipboardFiles(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        addFilesRef.current(files);
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const uploading = drafts.some((item) => item.status === "uploading");
  const readyDrafts = drafts.filter((item) => item.status === "ready");
  const canSend = (draft.trim() !== "" || readyDrafts.length > 0) && !uploading;
  const [pending, setPending] = useState<Pending | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const queueKey = conversationId ?? NEW_CONVERSATION;
  const queued = queues[queueKey] ?? [];
  const controllerRef = useRef<AbortController | null>(null);
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // The stored list stops polling once every command has ended, so a command born during the
  // answer is only in the stream: the approval dock needs both, the streamed one winning.
  const dockJobs = (() => {
    const byId = new Map<string, OpsJob>();
    for (const job of conversationJobs.data ?? []) {
      byId.set(job.id, job);
    }
    for (const job of pending?.jobs ?? []) {
      byId.set(job.id, job);
    }
    return [...byId.values()];
  })();

  const messages = conversationId ? (conversation.data?.messages ?? []) : [];
  const asked = messages.at(-1);
  const basePath = `/colleagues/${colleague.id}`;
  const wikiBase = `/offices/${office.id}/wiki`;

  // Someone who scrolled up is reading: only follow the end of the conversation for someone who
  // is already there. Following is given up on one signal alone, the view moving up away from the
  // end, because only a person makes that happen: an answer that grows leaves the view where it is
  // and just puts more below it, and one that shrinks moves the view up but leaves it at the end.
  // Reading the distance from the end instead would give up whenever the answer grew faster than
  // the browser reported our own scroll. Asking a question always follows again.
  const followEnd = useRef(true);
  const lastTop = useRef(0);
  function scrollToEnd() {
    const box = scrollBoxRef.current;
    if (!box) {
      return;
    }
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    lastTop.current = box.scrollTop;
  }
  // Text, command cards and the approval strip all change height on their own, and the strip
  // even takes height away from the transcript. A resize is seen after layout and before paint,
  // so the end can be held in the same frame instead of jumping up and catching up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the observer outlives every render
  useEffect(() => {
    const box = scrollBoxRef.current;
    const transcript = transcriptRef.current;
    if (!box || !transcript) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (followEnd.current) {
        scrollToEnd();
      }
    });
    observer.observe(box);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, []);
  // Another conversation starts at its end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the conversation is what resets it
  useEffect(() => {
    followEnd.current = true;
    lastTop.current = 0;
  }, [conversationId]);

  // The page only watches the answer; the server writes it (R-CHAT-13). Each watch has a number
  // so that one ending late cannot clear the state of the watch that replaced it.
  const watchRef = useRef(0);
  const watchedConversationRef = useRef<string | null>(null);

  function onStreamEvent(event: ChatStreamEvent) {
    const at = Date.now();
    setPending((current) => current && { ...current, lastEventAt: at });
    if (event.type === "context") {
      setPending((current) => current && { ...current, wikiContext: event.pages });
    } else if (event.type === "wiki_used") {
      setPending((current) => current && { ...current, wikiPages: event.pages });
    } else if (event.type === "tool") {
      setPending((current) => current && { ...current, activity: event.name });
    } else if (event.type === "ops_job") {
      // The command goes into the stored list as well, not only into the answer being watched:
      // when the answer ends that state is dropped, and a command still waiting for approval
      // would disappear from the strip until the page was reloaded. In the list it also turns
      // the polling back on, since a command waiting for a decision is not finished.
      if (conversationId) {
        queryClient.setQueryData<OpsJob[]>(
          opsKeys.conversation(office.id, conversationId),
          (current) => [event.job, ...(current ?? []).filter((job) => job.id !== event.job.id)],
        );
      }
      setPending(
        (current) =>
          current && {
            ...current,
            parts: withJob(current.parts, event.job.id),
            jobs: [...current.jobs.filter((job) => job.id !== event.job.id), event.job].sort(
              (a, b) => a.createdAt.localeCompare(b.createdAt),
            ),
          },
      );
    } else if (event.type === "wiki_edit") {
      setPending(
        (current) => current && { ...current, wikiEdits: [...current.wikiEdits, event.edit] },
      );
    } else if (event.type === "text") {
      setPending(
        (current) =>
          current && {
            ...current,
            parts: withText(current.parts, event.text),
            activity: null,
          },
      );
    } else if (event.type === "error") {
      setPending(
        (current) => current && { ...current, streamError: t(`errors.codes.${event.code}`) },
      );
    }
  }

  function startWatch(id: string | null) {
    const watch = ++watchRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    watchedConversationRef.current = id;
    setStreamingConversation(id);
    setStreaming(true);
    return { watch, controller };
  }

  // Once the answer is stored, the stored conversation takes the place of the live one.
  async function endWatch(watch: number, id: string | null | undefined) {
    if (id) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversation(id) }),
        queryClient.invalidateQueries({ queryKey: workspaceKeys.conversations(colleague.id) }),
        // What the commands ended up as, once nothing is watching them any more.
        queryClient.invalidateQueries({ queryKey: opsKeys.all(office.id) }),
      ]);
    }
    if (watchRef.current === watch) {
      controllerRef.current = null;
      watchedConversationRef.current = null;
      setStreamingConversation(null);
      setPending(null);
      setStreaming(false);
    }
  }

  // Enter sends what is written; while the colleague is still answering it is queued instead.
  function send() {
    const content = draft.trim();
    if (!canSend) {
      return;
    }
    const sent = readyDrafts;
    const busy = streaming || running;
    if (
      busy &&
      queued.reduce((count, item) => count + item.attachments.length, sent.length) >
        CHAT_ATTACHMENTS_MAX
    ) {
      setRequestError(t("chat.attachments.tooMany", { max: CHAT_ATTACHMENTS_MAX }));
      return;
    }
    for (const item of drafts.filter((draftItem) => draftItem.status === "error")) {
      removeDraft(item);
    }
    setRequestError(null);
    setDraft("");
    setDrafts([]);
    if (busy) {
      setQueues((current) => ({
        ...current,
        [queueKey]: [...(current[queueKey] ?? []), { key: localId(), content, attachments: sent }],
      }));
    } else {
      void deliver(content, sent);
    }
  }

  // Queued messages taken back: into the message box, before what is written there now.
  function returnToBox(items: QueuedMessage[]) {
    if (items.length === 0) {
      return;
    }
    setDraft((current) => joinMessages(...items.map((item) => item.content), current));
    setDrafts((current) => [...items.flatMap((item) => item.attachments), ...current]);
  }

  function editQueued(item: QueuedMessage) {
    setQueues((current) => ({
      ...current,
      [queueKey]: (current[queueKey] ?? []).filter((other) => other.key !== item.key),
    }));
    returnToBox([item]);
    messageRef.current?.focus();
  }

  function removeQueued(item: QueuedMessage) {
    setQueues((current) => ({
      ...current,
      [queueKey]: (current[queueKey] ?? []).filter((other) => other.key !== item.key),
    }));
    for (const attachment of item.attachments) {
      releaseAttachment(attachment);
    }
  }

  async function deliver(content: string, sent: DraftAttachment[]) {
    let restored = false;
    // Whoever asks wants to see the question and its answer: back to following the end, which
    // the question appearing below then brings into view.
    followEnd.current = true;

    let id = conversationId;
    const { watch, controller } = startWatch(id ?? null);
    try {
      if (!id) {
        const created = await apiFetch<ConversationSummary>("/conversations", {
          method: "POST",
          body: { colleagueId: colleague.id },
        });
        id = created.id;
        const createdId = id;
        // What was queued while it was being created now belongs to it.
        setQueues((current) => {
          const waiting = current[NEW_CONVERSATION];
          return waiting
            ? { ...withoutQueue(current, NEW_CONVERSATION), [createdId]: waiting }
            : current;
        });
        // Watched before the address changes, so the change does not count as leaving it.
        watchedConversationRef.current = id;
        setStreamingConversation(id);
        navigate(`${basePath}/${id}`, { replace: true });
      }
      setPending({
        content,
        resumed: false,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        parts: [],
        streamError: null,
        wikiContext: [],
        wikiPages: [],
        wikiEdits: [],
        activity: null,
        jobs: [],
        attachments: sent.map((item) => ({
          key: item.key,
          fileName: item.fileName,
          kind: item.kind,
          url: item.previewUrl,
        })),
      });
      await streamApi<ChatStreamEvent>(
        `/conversations/${id}/messages`,
        { content, attachmentIds: sent.flatMap((item) => item.attachment?.id ?? []) },
        onStreamEvent,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setRequestError(translateError(t, error));
        // Rejected before streaming: the message was not stored, so give it back, before what
        // may have been written since.
        if (error instanceof ApiRequestError) {
          setDraft((current) => joinMessages(content, current));
          setDrafts((current) => [...sent, ...current]);
          restored = true;
        }
      }
    } finally {
      await endWatch(watch, id);
      if (!restored) {
        for (const item of sent) {
          if (item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
          }
        }
      }
    }
  }

  // An answer still being written when the page opens, or started from elsewhere (another tab,
  // a command approved after the answer ended): followed from its beginning.
  async function follow(id: string) {
    const { watch, controller } = startWatch(id);
    // The answer began when the question was stored, which may be well before this page opened.
    const question = (conversation.data?.messages ?? []).findLast((item) => item.role === "user");
    const startedAt = question ? new Date(question.createdAt).getTime() : Date.now();
    setPending({
      content: "",
      resumed: true,
      startedAt,
      lastEventAt: Date.now(),
      parts: [],
      streamError: null,
      wikiContext: [],
      wikiPages: [],
      wikiEdits: [],
      activity: null,
      jobs: [],
      attachments: [],
    });
    try {
      await followApi<ChatStreamEvent>(
        `/conversations/${id}/stream`,
        onStreamEvent,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setRequestError(translateError(t, error));
      }
    } finally {
      await endWatch(watch, id);
    }
  }

  // Stop is the only thing that ends an answer early: leaving the page does not.
  function stop() {
    // What was queued followed an answer now cut short: back to the box, to send or not.
    returnToBox(queued);
    setQueues((current) => withoutQueue(current, queueKey));
    const id = watchedConversationRef.current;
    if (id) {
      void apiFetch(`/conversations/${id}/stop`, { method: "POST" }).catch((error: unknown) =>
        setRequestError(translateError(t, error)),
      );
    } else {
      // Nothing started on the server yet: the conversation was still being created.
      controllerRef.current?.abort();
    }
  }

  const running = conversation.data?.id === conversationId && conversation.data?.running === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow reads state it replaces itself
  useEffect(() => {
    if (running && !streaming && conversationId) {
      void follow(conversationId);
    }
  }, [running, streaming, conversationId]);

  // The queue goes once the answer has ended and the stored conversation, read again, says
  // nothing is running: here, or in a conversation left meanwhile when it is opened again.
  const conversationIdle =
    conversationId !== undefined &&
    conversation.data?.id === conversationId &&
    !conversation.isFetching &&
    !running &&
    !streaming;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliver reads state it replaces itself
  useEffect(() => {
    if (!conversationIdle || queued.length === 0) {
      return;
    }
    setQueues((current) => withoutQueue(current, queueKey));
    void deliver(
      joinMessages(...queued.map((item) => item.content)),
      queued.flatMap((item) => item.attachments),
    );
  }, [conversationIdle, queued, queueKey]);

  // Leaving a conversation stops watching its answer, not the answer: coming back picks it up.
  // The page lets go of it at once, before it is painted, so the answer never shows in the
  // conversation opened instead (another tab) and that one is free to send at once: the watch
  // ending later finds a newer number and leaves the page alone.
  useLayoutEffect(() => {
    const watched = watchedConversationRef.current;
    if (watched && watched !== conversationId) {
      controllerRef.current?.abort();
      watchRef.current += 1;
      controllerRef.current = null;
      watchedConversationRef.current = null;
      setStreamingConversation(null);
      setPending(null);
      setStreaming(false);
      setRequestError(null);
    }
  }, [conversationId]);
  // Only while a new conversation is being created on the first message: it opens as soon as it
  // exists, which would pull the person back from a tab chosen in the meantime.
  const creating = streaming && pending === null;

  // Closing the open conversation's tab moves to the tab beside it; with none left, to a new one.
  function closeTab(id: string) {
    const next = openTabs.close(id);
    if (id === conversationId) {
      navigate(next ? `${basePath}/${next}` : basePath, {
        replace: true,
        state: next ? undefined : { fresh: true },
      });
    }
  }

  // The open conversation's own controls: on its tab when the tabs are shown, else in the row
  // with the list. Closing stays one click on the tab; renaming and deleting, used now and then,
  // wait in a menu beside it, where deleting is not clicked by mistake.
  function conversationActions(small: boolean) {
    if (!conversationId) {
      return null;
    }
    if (renaming === conversationId) {
      return (
        <RenameConversation
          colleagueId={colleague.id}
          conversationId={conversationId}
          title={conversation.data?.title ?? null}
          onDone={() => {
            setRenaming(null);
            // Back on the menu it was opened from.
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>("[data-conversation-menu] button")?.focus(),
            );
          }}
        />
      );
    }
    return (
      <div data-conversation-menu>
        <Menu
          label={t("chat.conversationMenu")}
          fixed
          disabled={streaming || deleteConversation.isPending}
          buttonClassName={cn(buttonClasses("ghost", small ? "sm" : "icon"), small && TAB_BUTTON)}
          button={<Ellipsis aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil aria-hidden />}
                onClick={() => {
                  close();
                  setRenaming(conversationId);
                }}
              >
                {t("chat.rename")}
              </MenuItem>
              <MenuItem
                icon={<Trash2 aria-hidden />}
                className="text-destructive hover:text-destructive focus-visible:text-destructive [&_span]:text-inherit"
                onClick={() => {
                  close();
                  if (window.confirm(t("chat.deleteConfirm"))) {
                    deleteConversation.mutate(conversationId, {
                      // With the tabs shown it closes like its tab; else a new conversation.
                      onSuccess: () =>
                        tabsShown
                          ? closeTab(conversationId)
                          : navigate(basePath, { replace: true, state: { fresh: true } }),
                    });
                  }
                }}
              >
                {t("chat.deleteConversation")}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // A phone keyboard has no Shift+Enter: there Enter starts a new line and the button sends.
    if (touch) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-2 py-2 md:flex-wrap md:px-4 md:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className={cn(buttonClasses("ghost", "icon"), "md:hidden")}
            aria-label={t("chat.back")}
          >
            <ArrowLeft aria-hidden />
          </Link>
          <span
            className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"
            title={colleague.officeWide ? t("colleagues.officeWideHint") : undefined}
          >
            {colleague.officeWide ? (
              <UsersRound className="size-5" aria-hidden />
            ) : (
              <Bot className="size-5" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{colleague.name}</h1>
            <p className="truncate text-sm text-muted-foreground">
              {[
                colleague.title,
                colleague.officeWide
                  ? t("colleagues.officeWideOf", { office: office.name })
                  : office.name,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        {/* On a phone they wait on the list, one tap back: here the screen is the conversation's.
            The colleague's settings are on its row in that list. */}
        <div className="hidden shrink-0 md:block">
          <HeaderActions />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-2 sm:gap-2 sm:px-4">
        <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
          <label htmlFor="conversation-select" className="sr-only">
            {t("chat.conversation")}
          </label>
          <Select
            id="conversation-select"
            aria-describedby={waitingCount > 0 ? "conversations-waiting" : undefined}
            value={conversationId ?? ""}
            disabled={creating}
            onChange={(event) =>
              navigate(
                event.target.value ? `${basePath}/${event.target.value}` : basePath,
                event.target.value ? undefined : { state: { fresh: true } },
              )
            }
          >
            <option value="">{t("chat.newConversation")}</option>
            {(conversations.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.title ?? t("chat.untitled")}
                {item.waiting ? " ●" : ""} ·{" "}
                {new Date(item.updatedAt).toLocaleDateString(i18n.resolvedLanguage)}
              </option>
            ))}
          </Select>
          {/* Some conversation, open in a tab or not, waits for the person's approval: the dot
              shows on the closed menu, and on a phone too, where the tabs may be out of view. */}
          {waitingCount > 0 ? (
            <span
              id="conversations-waiting"
              role="img"
              aria-label={t("chat.conversationsWaiting", { count: waitingCount })}
              title={t("chat.conversationsWaiting", { count: waitingCount })}
              className="pointer-events-none absolute -top-1 -right-1 size-2.5 rounded-full bg-destructive ring-2 ring-background"
            />
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={creating || !conversationId}
          aria-label={t("chat.newConversation")}
          title={t("chat.newConversation")}
          onClick={() => navigate(basePath, { state: { fresh: true } })}
        >
          <Plus aria-hidden />
          <span className="hidden sm:inline">{t("chat.newConversation")}</span>
        </Button>
        {tabsShown ? null : conversationActions(false)}
        {/* Width and alignment are set now and then: one button, a menu in two sections. The
            menu stays open, so both can be set while the conversation shows the result. */}
        <div className="ml-auto hidden sm:block">
          <Menu
            label={t("chat.layout")}
            buttonClassName={buttonClasses("ghost", "icon")}
            button={<SlidersHorizontal aria-hidden />}
            className="w-52"
          >
            {() => (
              <>
                <MenuLabel>{t("chat.width.label")}</MenuLabel>
                {CHAT_WIDTHS.map((value) => (
                  <MenuItem
                    key={value}
                    checked={width === value}
                    onClick={() => {
                      setWidth(value);
                      storeValue(CHAT_WIDTH_KEY, value);
                    }}
                  >
                    {t(`chat.width.${value}`)}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuLabel>{t("chat.align.label")}</MenuLabel>
                {CHAT_ALIGNS.map((value) => (
                  <MenuItem
                    key={value}
                    checked={align === value}
                    disabled={width === "full"}
                    onClick={() => {
                      setAlign(value);
                      storeValue(CHAT_ALIGN_KEY, value);
                    }}
                  >
                    {t(`chat.align.${value}`)}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        </div>
      </div>

      {tabsShown ? (
        <ConversationTabs
          ids={openTabs.ids}
          conversationId={conversationId}
          conversations={conversations.data}
          disabled={creating}
          busy={streaming}
          onSelect={(id) => navigate(`${basePath}/${id}`)}
          onClose={closeTab}
          onMove={openTabs.move}
          actions={conversationActions(true)}
        />
      ) : null}

      <div
        ref={scrollBoxRef}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        aria-live="polite"
        onScroll={(event) => {
          const box = event.currentTarget;
          // The view moving up while it still sits at the end is the browser keeping it within a
          // transcript that got shorter, as when command cards fold once the answer is over.
          const fromEnd = box.scrollHeight - box.scrollTop - box.clientHeight;
          if (box.scrollTop < lastTop.current - 2 && fromEnd > 2) {
            followEnd.current = false;
          } else if (fromEnd < 120) {
            followEnd.current = true;
          }
          lastTop.current = box.scrollTop;
        }}
      >
        <div ref={transcriptRef} className={cn("space-y-5 px-4 py-6", layoutClass)}>
          {conversation.isError ? (
            <ErrorAlert>{translateError(t, conversation.error)}</ErrorAlert>
          ) : null}

          {messages.length === 0 && !pending && !conversation.isFetching ? (
            <div className="space-y-2 py-16 text-center">
              <Bot className="mx-auto size-10 text-primary" aria-hidden />
              <h2 className="text-lg font-semibold">
                {t("chat.emptyTitle", { name: colleague.name })}
              </h2>
              <p className="text-sm text-muted-foreground">{t("chat.emptyDescription")}</p>
            </div>
          ) : null}

          {messages.map((message) => (
            <StoredMessage
              key={message.id}
              message={message}
              officeId={office.id}
              wikiBase={wikiBase}
              // The office colleague only reads the wiki: nothing of its answers is filed (R-ADM-8).
              conversationId={colleague.officeWide ? null : (conversationId ?? null)}
            />
          ))}

          {conversationId && conversation.data?.id === conversationId && !pending ? (
            <WikiCandidates
              key={conversationId}
              conversationId={conversationId}
              candidates={conversation.data.wikiCandidates}
              wikiBase={wikiBase}
            />
          ) : null}

          {pending ? (
            <>
              {/* The message is stored as soon as it is sent, so a refresh arriving while the
                  answer streams brings it back: show the copy being sent only until then. */}
              {pending.resumed ||
              (asked?.content === pending.content && asked.role === "user") ? null : (
                <MessageBubble
                  author="user"
                  content={pending.content}
                  attachments={pending.attachments}
                  officeId={office.id}
                  status="complete"
                  errorText={null}
                  wikiBase={wikiBase}
                />
              )}
              <MessageBubble
                author="assistant"
                content=""
                parts={pending.parts}
                status="complete"
                errorText={pending.streamError}
                streaming={!pending.streamError}
                wikiBase={wikiBase}
                wikiPages={pending.wikiPages}
                knownPages={pending.wikiContext}
                wikiEdits={pending.wikiEdits}
                officeId={office.id}
                liveJobs={pending.jobs}
                activity={pending.streamError ? null : pending.activity}
                startedAt={pending.startedAt}
                lastEventAt={pending.lastEventAt}
              />
            </>
          ) : null}
        </div>
      </div>

      <ApprovalDock officeId={office.id} jobs={dockJobs} layoutClass={layoutClass} />

      {archived || colleague.needsProfile ? (
        <section aria-label={t("chat.message")} className="border-t bg-background px-4 py-3">
          <div
            role="status"
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm",
              layoutClass,
            )}
          >
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {archived
                ? t("chat.archived", { name: colleague.name })
                : settingsPath
                  ? t("chat.needsProfile", { name: colleague.name })
                  : t("chat.unavailable", { name: colleague.name })}
            </span>
            {archived ? (
              <Button
                size="sm"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ id: colleague.id, archived: false })}
              >
                {t("colleagues.keep.restore")}
              </Button>
            ) : settingsPath ? (
              <Link to={settingsPath} className={buttonClasses("outline", "sm")}>
                {t("chat.chooseProfile")}
              </Link>
            ) : null}
          </div>
          {restore.isError ? (
            <div className={cn("mt-2", layoutClass)}>
              <ErrorAlert>{translateError(t, restore.error)}</ErrorAlert>
            </div>
          ) : null}
        </section>
      ) : (
        <section
          aria-label={t("chat.message")}
          className={cn("border-t bg-background px-4 py-3", dragging && "bg-primary/5")}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            if (event.dataTransfer.files.length > 0) {
              event.preventDefault();
              setDragging(false);
              addFiles([...event.dataTransfer.files]);
            }
          }}
        >
          <form
            className={cn("space-y-2", layoutClass)}
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            {dragging ? (
              <p className="text-center text-sm text-primary">{t("chat.attachments.drop")}</p>
            ) : null}
            {drafts.length > 0 ? (
              <ul className="flex flex-wrap gap-2" aria-label={t("chat.attachments.label")}>
                {drafts.map((item) => (
                  <li
                    key={item.key}
                    className={cn(
                      "flex max-w-72 items-center gap-2 rounded-lg border bg-card p-1.5 pr-1 text-sm",
                      item.status === "error" && "border-destructive/60",
                    )}
                  >
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt="" className="size-9 rounded object-cover" />
                    ) : (
                      <FileText className="size-5 shrink-0 text-primary" aria-hidden />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate">{item.fileName}</span>
                      {item.status === "uploading" ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                          {t("chat.attachments.uploading")}
                        </span>
                      ) : item.status === "error" ? (
                        <span
                          className="block truncate text-xs text-destructive"
                          title={item.error}
                        >
                          {item.error}
                        </span>
                      ) : item.attachment?.truncated ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("chat.attachments.truncated")}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      aria-label={t("chat.attachments.remove", { name: item.fileName })}
                      onClick={() => removeDraft(item)}
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {requestError ? <ErrorAlert>{requestError}</ErrorAlert> : null}
            {queued.length > 0 ? (
              <div className="space-y-1">
                <p id="chat-queue" className="text-xs text-muted-foreground">
                  {t("chat.queue.label", { name: colleague.name })}
                </p>
                <ul className="space-y-1" aria-labelledby="chat-queue">
                  {queued.map((item) => (
                    <li
                      key={item.key}
                      className="flex items-start gap-1 rounded-lg border border-dashed bg-muted/40 py-1 pr-1 pl-3 text-sm"
                    >
                      <span className="min-w-0 flex-1 py-0.5">
                        <span className="line-clamp-2 whitespace-pre-wrap break-words">
                          {item.content}
                        </span>
                        {item.attachments.length > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("chat.queue.files", { count: item.attachments.length })}
                          </span>
                        ) : null}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0"
                        aria-label={t("chat.queue.edit")}
                        title={t("chat.queue.edit")}
                        onClick={() => editQueued(item)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0"
                        aria-label={t("chat.queue.remove")}
                        title={t("chat.queue.remove")}
                        onClick={() => removeQueued(item)}
                      >
                        <X aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <label htmlFor="chat-message" className="sr-only">
              {t("chat.message")}
            </label>
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(event) => {
                  addFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("chat.attachments.add")}
                title={t("chat.attachments.add")}
                disabled={drafts.length >= CHAT_ATTACHMENTS_MAX}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip aria-hidden />
              </Button>
              {/* The box grows with the text by itself, so it has no grip to drag. Stop sits inside
                  it, so the box keeps its width while an answer is written. */}
              <div className="relative min-w-0 flex-1">
                <Textarea
                  ref={messageRef}
                  id="chat-message"
                  rows={2}
                  className={cn("block max-h-60 min-h-12 resize-none", streaming && "pr-12")}
                  value={draft}
                  placeholder={t(touch ? "chat.placeholderTouch" : "chat.placeholder", {
                    name: colleague.name,
                  })}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                />
                {streaming ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="absolute right-1.5 bottom-1.5 size-8"
                    aria-label={t("chat.stop")}
                    title={t("chat.stop")}
                    onClick={stop}
                  >
                    <Square aria-hidden />
                  </Button>
                ) : null}
              </div>
              {/* On a computer Enter sends; a phone keyboard has no Shift+Enter, so there Enter
                  starts a new line and this button sends, or queues while an answer is written. */}
              {touch ? (
                <Button type="submit" size="icon" aria-label={t("chat.send")} disabled={!canSend}>
                  <Send aria-hidden />
                </Button>
              ) : null}
            </div>
            {/* Where the next message is written: how much room is left before the conversation is
                summarized. Lined up with the end of the message box, left of the send button on a
                phone. */}
            {conversationId && conversation.data ? (
              <div className={cn("-mt-1 flex justify-end empty:hidden", touch && "pr-11")}>
                <ContextMeter conversation={conversation.data} />
              </div>
            ) : null}
          </form>
        </section>
      )}
    </div>
  );
}
