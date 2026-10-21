import type {
  ChatAttachmentKind,
  ChatRole,
  MessagePart,
  MessageStatus,
  OpsJob,
  WikiEdit,
  WikiPageRef,
} from "@orlok/shared";
import { BookmarkPlus, BookOpen, Bot, Check, FilePen, FileText, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useOpsJobs } from "@/lib/ops-queries";
import { useSaveAnswerToWiki } from "@/lib/workspace-queries";
import { Markdown } from "./Markdown";
import { OpsJobCard } from "./OpsJobCard";
import { OpsPlanCard } from "./OpsPlanCard";

const ACTIVITIES = [
  "wiki_search",
  "wiki_read",
  "wiki_write",
  "wiki_edit",
  "wiki_flag",
  "ops_targets",
  "ops_exec",
  "ops_job",
] as const;

function isKnownActivity(name: string): name is (typeof ACTIVITIES)[number] {
  return (ACTIVITIES as readonly string[]).includes(name);
}

// What the answer is made of, laid out the way it happened: the text, and the command that
// interrupted it right where it interrupted it (R-CHAT-4). Consecutive steps of one plan are
// shown together in their plan card (R-OPS-6).
type AnswerRow =
  | { kind: "text"; key: string; text: string }
  | { kind: "job"; job: OpsJob }
  | { kind: "plan"; id: string; jobs: OpsJob[] };

// Jobs of an answer still streaming come from the stream; the stored ones are loaded by id.
function Answer({
  parts,
  officeId,
  liveJobs,
  wikiBase,
  wikiTitles,
}: {
  parts: MessagePart[];
  officeId: string;
  liveJobs: OpsJob[];
  wikiBase: string;
  wikiTitles: Map<string, string>;
}) {
  const live = new Map(liveJobs.map((job) => [job.id, job]));
  const stored = useOpsJobs(
    officeId,
    parts.flatMap((part) => (part.type === "job" && !live.has(part.jobId) ? [part.jobId] : [])),
  );
  const byId = new Map<string, OpsJob>();
  for (const job of stored.data ?? []) {
    byId.set(job.id, job);
  }
  for (const job of liveJobs) {
    byId.set(job.id, job);
  }

  const rows: AnswerRow[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type === "text") {
      rows.push({ kind: "text", key: `text-${index}`, text: part.text });
      continue;
    }
    const job = byId.get(part.jobId);
    if (!job) {
      continue;
    }
    const planId = job.plan?.id;
    const last = rows.at(-1);
    if (planId && last?.kind === "plan" && last.id === planId) {
      last.jobs.push(job);
    } else if (planId) {
      rows.push({ kind: "plan", id: planId, jobs: [job] });
    } else {
      rows.push({ kind: "job", job });
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      {rows.map((row) =>
        row.kind === "text" ? (
          <Markdown key={row.key} wikiBase={wikiBase} wikiTitles={wikiTitles}>
            {row.text}
          </Markdown>
        ) : row.kind === "plan" ? (
          <OpsPlanCard key={row.id} officeId={officeId} jobs={row.jobs} />
        ) : (
          <OpsJobCard key={row.job.id} job={row.job} />
        ),
      )}
    </div>
  );
}

// Attachment shown in a message: stored (url of the file) or still being sent (local preview).
export type DisplayAttachment = {
  key: string;
  fileName: string;
  kind: ChatAttachmentKind;
  url: string | null;
};

type MessageBubbleProps = {
  attachments?: DisplayAttachment[];
  author: ChatRole;
  content: string;
  status: MessageStatus;
  errorText: string | null;
  streaming?: boolean;
  // Office wiki used for [[links]] and for the pages consulted for this answer.
  wikiBase: string;
  wikiPages?: WikiPageRef[];
  // Other pages whose titles name links of the answer, e.g. those given before answering.
  knownPages?: WikiPageRef[];
  wikiEdits?: WikiEdit[];
  // Tool the colleague is using while the answer streams.
  activity?: string | null;
  // When the answer began and when it last showed a sign of life (ms): a colleague silent for a
  // while is still shown at work, with how long it has been going.
  startedAt?: number;
  lastEventAt?: number;
  // Stored answers can be filed into the wiki by the colleague.
  saveTarget?: { conversationId: string; messageId: string } | null;
  // The answer in order (R-CHAT-4); the user's own message only needs `content`.
  parts?: MessagePart[];
  // Commands of this answer: the live jobs of an answer being streamed, else loaded by id.
  officeId: string;
  liveJobs?: OpsJob[];
};

function WorkingDots({ label }: { label?: string }) {
  return (
    <span className="inline-flex gap-1 py-2" role="status" aria-label={label}>
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
    </span>
  );
}

// Once some text is written, a model preparing a long tool call (a whole wiki page) can go quiet
// for minutes. Without a sign of life the answer looks stuck, and people stop it or ask again.
const QUIET_MS = 3_000;

function StillWorking({ startedAt, lastEventAt }: { startedAt?: number; lastEventAt?: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (lastEventAt === undefined || now - lastEventAt < QUIET_MS) {
    return null;
  }
  const seconds = startedAt === undefined ? 0 : Math.max(0, Math.round((now - startedAt) / 1_000));
  const elapsed =
    seconds >= 60
      ? t("chat.activity.minutes", { count: Math.floor(seconds / 60) })
      : t("chat.activity.seconds", { count: seconds });
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {startedAt === undefined
        ? t("chat.activity.generic")
        : t("chat.activity.stillWorking", { elapsed })}
    </p>
  );
}

export function MessageBubble({
  author,
  content,
  status,
  errorText,
  streaming = false,
  wikiBase,
  wikiPages = [],
  knownPages = [],
  wikiEdits = [],
  activity = null,
  startedAt,
  lastEventAt,
  saveTarget = null,
  officeId,
  parts = [],
  liveJobs = [],
  attachments = [],
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const save = useSaveAnswerToWiki();
  const wikiTitles = useMemo(
    () =>
      new Map([...knownPages, ...wikiPages, ...wikiEdits].map((page) => [page.slug, page.title])),
    [knownPages, wikiPages, wikiEdits],
  );

  if (author === "user") {
    const images = attachments.filter((item) => item.kind === "image");
    const documents = attachments.filter((item) => item.kind === "document");
    return (
      <div className="flex flex-col items-end gap-1.5">
        {images.length > 0 ? (
          <ul className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {images.map((item) => (
              <li key={item.key}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-lg border focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <img
                      src={item.url}
                      alt={item.fileName}
                      className="h-32 max-w-60 object-cover"
                      loading="lazy"
                    />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {documents.length > 0 ? (
          <ul className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {documents.map((item) => (
              <li key={item.key}>
                {item.url ? (
                  <a
                    href={item.url}
                    download={item.fileName}
                    className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="truncate">{item.fileName}</span>
                  </a>
                ) : (
                  <span className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-sm">
                    <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="truncate">{item.fileName}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {content ? (
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 whitespace-pre-wrap text-primary-foreground">
            {content}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
        <Bot className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <Answer
          parts={parts}
          officeId={officeId}
          liveJobs={liveJobs}
          wikiBase={wikiBase}
          wikiTitles={wikiTitles}
        />
        {parts.length === 0 && streaming && !activity ? (
          <WorkingDots label={t("common.loading")} />
        ) : null}
        {parts.length > 0 && streaming && !activity ? (
          <StillWorking startedAt={startedAt} lastEventAt={lastEventAt} />
        ) : null}
        {activity ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {isKnownActivity(activity)
              ? t(`chat.activity.${activity}`)
              : t("chat.activity.generic")}
          </p>
        ) : null}
        {wikiEdits.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <FilePen className="size-3.5 text-primary" aria-hidden />
            <span>{t("chat.wikiUpdated")}</span>
            {wikiEdits.map((edit) => (
              <Link
                key={edit.slug}
                to={`${wikiBase}/${edit.slug}`}
                className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {edit.title}
                {edit.action === "create" ? ` · ${t("chat.wikiNew")}` : ""}
              </Link>
            ))}
          </div>
        ) : null}
        {wikiPages.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <BookOpen className="size-3.5" aria-hidden />
            <span>{t("chat.wikiUsed")}</span>
            {wikiPages.map((page) => (
              <Link
                key={page.slug}
                to={`${wikiBase}/${page.slug}`}
                className="rounded-full border px-2 py-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {page.title}
              </Link>
            ))}
          </div>
        ) : null}
        {saveTarget && content && status === "complete" ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {save.isSuccess ? (
              <span className="inline-flex items-center gap-1" aria-live="polite">
                <Check className="size-3.5 text-success" aria-hidden />
                {t("chat.savedToWiki")}
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={save.isPending}
                onClick={() => save.mutate(saveTarget)}
              >
                {save.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <BookmarkPlus aria-hidden />
                )}
                {t("chat.saveToWiki")}
              </Button>
            )}
            {save.isError ? (
              <span className="text-destructive">{translateError(t, save.error)}</span>
            ) : null}
          </div>
        ) : null}
        {status === "stopped" ? (
          <p className="text-xs text-muted-foreground">{t("chat.stopped")}</p>
        ) : null}
        {errorText ? <ErrorAlert>{errorText}</ErrorAlert> : null}
      </div>
    </div>
  );
}
