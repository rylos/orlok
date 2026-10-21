import {
  WIKI_DOCUMENT_EXTENSIONS,
  WIKI_DOCUMENT_MAX_BYTES,
  type WikiSource,
  type WikiSourceUploadResult,
} from "@orlok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { formatNumber, translateError } from "@/i18n/errors";
import { useColleagueRefName } from "@/lib/colleague-queries";
import { cn } from "@/lib/utils";
import {
  useDeleteWikiSource,
  useRetryWikiSource,
  useUploadWikiSources,
  useWikiSources,
  wikiKeys,
} from "@/lib/wiki-queries";
import { useWorkspaceOffices } from "@/lib/workspace-queries";
import { formatDateTime, useWiki } from "./shared";

// Below the server request limit, leaving room for multipart encoding.
const UPLOAD_TOTAL_LIMIT = 45 * 1024 * 1024;
const ACCEPT = WIKI_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(",");

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${formatNumber(Math.round((bytes / 1024 / 1024) * 10) / 10)} MB`
    : `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

function statusVariant(status: WikiSource["status"]) {
  return status === "done" ? "success" : status === "error" ? "neutral" : "primary";
}

function SourceItem({ source }: { source: WikiSource }) {
  const { t } = useTranslation();
  const colleagueName = useColleagueRefName();
  const { officeId, base, pageTitles } = useWiki();
  const retry = useRetryWikiSource(officeId);
  const remove = useDeleteWikiSource(officeId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = source.status === "queued" || source.status === "processing";

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <FileText className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="break-all">{source.fileName}</span>
            <Badge variant={statusVariant(source.status)}>
              {source.status === "processing" ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : null}
              {source.status === "processing" && source.stage
                ? t(`wiki.importView.stages.${source.stage}`)
                : t(`wiki.importView.status.${source.status}`)}
              {source.status === "processing" && source.progress
                ? ` ${source.progress.done}/${source.progress.total}`
                : ""}
            </Badge>
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              source.colleague ? colleagueName(source.colleague) : null,
              source.uploadedBy ? t("wiki.importView.sentBy", { name: source.uploadedBy }) : null,
              formatDateTime(source.createdAt),
              formatSize(source.sizeBytes),
              source.ocrUnits > 0 ? t("wiki.importView.ocr", { count: source.ocrUnits }) : null,
              source.imageCount > 0
                ? t("wiki.importView.images", { count: source.imageCount })
                : null,
              source.secretsRemoved > 0
                ? t("wiki.importView.documentSecrets", { count: source.secretsRemoved })
                : null,
              source.status === "done" && source.outcome
                ? t(`wiki.importView.outcomes.${source.outcome}`)
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {pending ? null : (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={retry.isPending}
              onClick={() => retry.mutate(source.id)}
            >
              <RotateCcw aria-hidden />
              {t("wiki.importView.retry")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              aria-label={t("wiki.importView.deleteSource")}
              title={t("wiki.importView.deleteSource")}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        )}
      </div>
      {confirmDelete ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p>{t("wiki.importView.deleteChoice", { name: source.fileName })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: source.id, cascade: false })}
            >
              {t("wiki.importView.deleteOnlyList")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: source.id, cascade: true })}
            >
              <Trash2 aria-hidden />
              {t("wiki.importView.deleteWithPages")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {source.truncated ? (
        <p className="text-xs text-muted-foreground">{t("wiki.importView.truncated")}</p>
      ) : null}
      {source.status === "error" ? (
        <ErrorAlert>
          {source.errorCode
            ? t(`wiki.importView.errors.${source.errorCode}`)
            : t("wiki.importView.errors.internal_error")}
          {source.error &&
          (source.errorCode === "provider_error" || source.errorCode === "internal_error")
            ? `: ${source.error}`
            : ""}
        </ErrorAlert>
      ) : null}
      {retry.isError || remove.isError ? (
        <ErrorAlert>{translateError(t, retry.error ?? remove.error)}</ErrorAlert>
      ) : null}
      {source.edits.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {source.edits.map((edit) => (
            <li key={edit.slug}>
              {pageTitles.has(edit.slug) ? (
                <Link
                  to={`${base}/${edit.slug}`}
                  className="inline-block rounded-full border px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {edit.title}
                  {edit.action === "create" ? ` · ${t("wiki.importView.newPage")}` : ""}
                </Link>
              ) : (
                <span className="inline-block rounded-full border px-2 py-0.5 text-xs text-muted-foreground line-through">
                  {edit.title}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// Office documents filed into the wiki by a virtual colleague (R-MEM-3).
export function WikiDocuments() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { officeId } = useWiki();
  const offices = useWorkspaceOffices();
  const sources = useWikiSources(officeId);
  const upload = useUploadWikiSources(officeId);
  const [colleagueId, setColleagueId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<WikiSourceUploadResult | null>(null);

  // The person's own colleagues in the office, with a profile they still hold (R-ADM-3).
  const colleagues = (
    offices.data?.find((office) => office.id === officeId)?.colleagues ?? []
  ).filter((colleague) => !colleague.needsProfile);
  const selectedColleague = colleagueId || colleagues[0]?.id || "";
  const totalSize = files.reduce((total, file) => total + file.size, 0);

  // When documents finish, their pages appear: refresh lists, log and search.
  const pendingCount =
    sources.data?.filter((item) => item.status === "queued" || item.status === "processing")
      .length ?? 0;
  const previousPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount < previousPending.current) {
      void queryClient.invalidateQueries({ queryKey: wikiKeys.all(officeId) });
    }
    previousPending.current = pendingCount;
  }, [pendingCount, officeId, queryClient]);

  function send() {
    const form = new FormData();
    form.append("colleagueId", selectedColleague);
    for (const file of files) {
      form.append("files", file, file.name);
    }
    upload.mutate(form, {
      onSuccess: (data) => {
        setResult(data);
        setFiles([]);
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-semibold">{t("wiki.importView.documentsTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("wiki.importView.documentsDescription")}</p>
        <p className="text-xs text-muted-foreground">
          {t("wiki.importView.formats", {
            formats: WIKI_DOCUMENT_EXTENSIONS.join(", "),
            size: WIKI_DOCUMENT_MAX_BYTES / 1024 / 1024,
          })}
        </p>
      </div>

      {offices.isPending ? null : colleagues.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t("wiki.importView.noColleague")}{" "}
          <Link className="font-medium underline" to={`/offices/${officeId}/colleagues/new`}>
            {t("colleagues.new")}
          </Link>
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
            <FormField id="wiki-documents-colleague" label={t("wiki.importView.colleague")}>
              <Select
                id="wiki-documents-colleague"
                value={selectedColleague}
                onChange={(event) => setColleagueId(event.target.value)}
              >
                {colleagues.map((colleague) => (
                  <option key={colleague.id} value={colleague.id}>
                    {colleague.title ? `${colleague.name} · ${colleague.title}` : colleague.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <label className={cn(buttonClasses("outline", "md"), "cursor-pointer")}>
              <FileText aria-hidden />
              {t("wiki.importView.chooseDocuments")}
              <input
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={(event) => {
                  setFiles([...(event.target.files ?? [])]);
                  setResult(null);
                  upload.reset();
                  event.target.value = "";
                }}
              />
            </label>
          </div>

          {files.length > 0 ? (
            <div className="space-y-1 text-sm" aria-live="polite">
              <p>
                {t("wiki.importView.selected", { count: files.length })} · {formatSize(totalSize)}
              </p>
              {totalSize > UPLOAD_TOTAL_LIMIT ? (
                <ErrorAlert>{t("wiki.importView.tooLarge")}</ErrorAlert>
              ) : null}
            </div>
          ) : null}

          {upload.isError ? <ErrorAlert>{translateError(t, upload.error)}</ErrorAlert> : null}
          {result && result.rejected.length > 0 ? (
            <ErrorAlert>
              <p>{t("wiki.importView.rejected")}</p>
              <ul className="list-disc pl-5">
                {result.rejected.map((item) => (
                  <li key={item.fileName}>
                    {item.fileName}: {t(`wiki.importView.rejections.${item.reason}`)}
                  </li>
                ))}
              </ul>
            </ErrorAlert>
          ) : null}

          <div className="flex justify-end">
            <Button
              disabled={
                files.length === 0 ||
                totalSize > UPLOAD_TOTAL_LIMIT ||
                !selectedColleague ||
                upload.isPending
              }
              onClick={send}
            >
              {upload.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              {t("wiki.importView.upload")}
            </Button>
          </div>
        </>
      )}

      {sources.isError ? <ErrorAlert>{translateError(t, sources.error)}</ErrorAlert> : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="divide-y rounded-md border bg-background">
          {sources.data.map((source) => (
            <SourceItem key={source.id} source={source} />
          ))}
        </ul>
      ) : sources.data ? (
        <p className="text-sm text-muted-foreground">{t("wiki.importView.noSources")}</p>
      ) : null}
    </div>
  );
}
