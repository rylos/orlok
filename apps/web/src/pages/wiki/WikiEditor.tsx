import {
  slugify,
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  WIKI_SLUG_MAX,
  WIKI_TITLE_MAX,
  type WikiPage,
  type WikiPageStatus,
  type WikiPageType,
} from "@orlok/shared";
import { Loader2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/features/chat/Markdown";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCreateWikiPage, useUpdateWikiPage, useWikiPage } from "@/lib/wiki-queries";
import { useWiki, WikiLoader } from "./shared";

type WikiEditorProps = { page?: WikiPage; initialSlug?: string };

function WikiEditorForm({ page, initialSlug = "" }: WikiEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { officeId, base, overview, pageTitles } = useWiki();
  const create = useCreateWikiPage(officeId);
  const update = useUpdateWikiPage(officeId, page?.slug ?? "");
  const save = page ? update : create;

  const [title, setTitle] = useState(page?.title ?? "");
  const [slug, setSlug] = useState(initialSlug);
  const [slugTouched, setSlugTouched] = useState(Boolean(initialSlug));
  const [section, setSection] = useState(page?.section ?? "");
  const [type, setType] = useState<WikiPageType>(page?.type ?? "note");
  const [status, setStatus] = useState<WikiPageStatus>(page?.status ?? "current");
  const [verifiedOn, setVerifiedOn] = useState(page?.verifiedOn ?? "");
  const [sources, setSources] = useState((page?.sources ?? []).join("\n"));
  const [content, setContent] = useState(page?.content ?? "");
  const [summary, setSummary] = useState("");
  const [preview, setPreview] = useState(false);

  const sections = useMemo(
    () => [...new Set(overview.pages.map((item) => item.section).filter(Boolean))] as string[],
    [overview.pages],
  );
  const effectiveSlug = page?.slug ?? (slugTouched ? slug : title.trim() ? slugify(title) : "");
  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const conflict =
    save.error instanceof ApiRequestError && save.error.body.code === "revision_conflict";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = {
      title,
      section: section.trim() || null,
      type,
      status,
      verifiedOn: verifiedOn || null,
      sources: sources
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      content,
    };
    const done = (saved: WikiPage) => navigate(`${base}/${saved.slug}`);
    if (page) {
      update.mutate({ ...fields, baseRevision: page.revision, summary }, { onSuccess: done });
    } else {
      create.mutate({ ...fields, slug: effectiveSlug || undefined }, { onSuccess: done });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <h2 className="text-2xl font-semibold tracking-tight">
        {page ? t("wiki.editor.editTitle", { title: page.title }) : t("wiki.editor.createTitle")}
      </h2>

      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>
          {conflict ? t("wiki.editor.conflict") : translateError(t, save.error)}
        </ErrorAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormField id="wiki-title" label={t("wiki.editor.title")} error={errors.title}>
            <Input
              id="wiki-title"
              required
              maxLength={WIKI_TITLE_MAX}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={Boolean(errors.title)}
            />
          </FormField>
        </div>

        {page ? null : (
          <div className="sm:col-span-2">
            <FormField
              id="wiki-slug"
              label={t("wiki.editor.slug")}
              error={errors.slug}
              hint={t("wiki.editor.slugHint", { slug: effectiveSlug || "…" })}
            >
              <Input
                id="wiki-slug"
                className="font-mono"
                maxLength={WIKI_SLUG_MAX}
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value);
                }}
                aria-invalid={Boolean(errors.slug)}
                aria-describedby="wiki-slug-message"
              />
            </FormField>
          </div>
        )}

        <FormField
          id="wiki-section"
          label={t("wiki.editor.section")}
          error={errors.section}
          hint={t("wiki.editor.sectionHint")}
        >
          <Input
            id="wiki-section"
            list="wiki-sections"
            value={section}
            onChange={(event) => setSection(event.target.value)}
            aria-describedby="wiki-section-message"
          />
          <datalist id="wiki-sections">
            {sections.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </FormField>

        <FormField id="wiki-type" label={t("wiki.editor.type")}>
          <Select
            id="wiki-type"
            value={type}
            onChange={(event) => setType(event.target.value as WikiPageType)}
          >
            {WIKI_PAGE_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`wiki.types.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id="wiki-status"
          label={t("wiki.editor.status")}
          hint={t("wiki.editor.statusHint")}
        >
          <Select
            id="wiki-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as WikiPageStatus)}
          >
            {WIKI_PAGE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`wiki.statuses.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id="wiki-verified"
          label={t("wiki.editor.verifiedOn")}
          hint={t("wiki.editor.verifiedOnHint")}
          error={errors.verifiedOn}
        >
          <Input
            id="wiki-verified"
            type="date"
            value={verifiedOn}
            onChange={(event) => setVerifiedOn(event.target.value)}
          />
        </FormField>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label htmlFor="wiki-content" className="block text-sm font-medium">
            {t("wiki.editor.content")}
          </label>
          <div className="flex rounded-md border p-0.5">
            {[false, true].map((value) => (
              <button
                key={String(value)}
                type="button"
                aria-pressed={preview === value}
                onClick={() => setPreview(value)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring",
                  preview === value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value ? t("wiki.editor.preview") : t("wiki.editor.write")}
              </button>
            ))}
          </div>
        </div>
        {preview ? (
          <div className="min-h-80 rounded-md border bg-card p-4">
            {content.trim() ? (
              <Markdown wikiBase={base} wikiTitles={pageTitles} markMissing>
                {content}
              </Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">{t("wiki.editor.nothingToPreview")}</p>
            )}
          </div>
        ) : (
          <Textarea
            id="wiki-content"
            rows={20}
            className="min-h-80 font-mono text-[0.85rem] leading-relaxed"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            aria-invalid={Boolean(errors.content)}
            aria-describedby="wiki-content-message"
          />
        )}
        <p id="wiki-content-message" className="text-sm text-muted-foreground">
          {errors.content ?? t("wiki.editor.contentHint")}
        </p>
      </div>

      <FormField
        id="wiki-sources"
        label={t("wiki.editor.sources")}
        error={errors.sources}
        hint={t("wiki.editor.sourcesHint")}
      >
        <Textarea
          id="wiki-sources"
          rows={3}
          value={sources}
          onChange={(event) => setSources(event.target.value)}
          aria-describedby="wiki-sources-message"
        />
      </FormField>

      {page ? (
        <FormField id="wiki-summary" label={t("wiki.editor.summary")} error={errors.summary}>
          <Input
            id="wiki-summary"
            maxLength={200}
            placeholder={t("wiki.editor.summaryPlaceholder")}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </FormField>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Link to={page ? `${base}/${page.slug}` : base} className={buttonClasses("ghost", "md")}>
          {t("common.cancel")}
        </Link>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("wiki.editor.save")}
        </Button>
      </div>
    </form>
  );
}

function ReadOnly() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <ErrorAlert>{t("wiki.readOnly")}</ErrorAlert>
    </div>
  );
}

export function WikiNewPage() {
  const { overview } = useWiki();
  const [params] = useSearchParams();
  if (!overview.canEdit) {
    return <ReadOnly />;
  }
  return <WikiEditorForm initialSlug={params.get("slug") ?? ""} />;
}

export function WikiEditPage() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const { officeId, overview } = useWiki();
  const page = useWikiPage(officeId, slug);

  if (!overview.canEdit) {
    return <ReadOnly />;
  }
  if (page.isPending) {
    return <WikiLoader />;
  }
  if (page.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ErrorAlert>{translateError(t, page.error)}</ErrorAlert>
      </div>
    );
  }
  // Keyed by revision: after a save or a restore the form starts from the stored page.
  return <WikiEditorForm key={page.data.revision} page={page.data} />;
}
