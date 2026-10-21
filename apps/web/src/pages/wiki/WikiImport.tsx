import { WIKI_IMPORT_FILES_MAX } from "@orlok/shared";
import { CheckCircle2, FileText, FolderOpen, Loader2, Upload } from "lucide-react";
import { type DragEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import { useImportWiki } from "@/lib/wiki-queries";
import { droppedFiles, type PickedFile, pickedFiles, readImportFiles } from "./import-files";
import { useWiki } from "./shared";
import { WikiDocuments } from "./WikiDocuments";

// Below the server request limit, leaving room for JSON encoding.
const IMPORT_SIZE_LIMIT = 40 * 1024 * 1024;

type Selection = {
  files: { path: string; content: string }[];
  ignored: number;
  error: "tooMany" | "tooLarge" | "unreadable" | null;
};

// Import into the wiki: office documents filed by a virtual colleague (R-MEM-3) and Markdown
// folders imported as they are, e.g. Obsidian or a Joplin "Markdown + Front Matter" export (R-MEM-11).
export function WikiImport() {
  const { t } = useTranslation();
  const { officeId, base, overview } = useWiki();
  const importWiki = useImportWiki(officeId);
  const [section, setSection] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  if (!overview.canEdit) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ErrorAlert>{t("wiki.readOnly")}</ErrorAlert>
      </div>
    );
  }

  async function take(picked: Promise<PickedFile[]> | PickedFile[]) {
    importWiki.reset();
    setReading(true);
    try {
      const { files, ignored } = await readImportFiles(await picked);
      if (files.length === 0 && ignored === 0) {
        setSelection(null);
        return;
      }
      const size = files.reduce((total, file) => total + file.size, 0);
      const error =
        files.length > WIKI_IMPORT_FILES_MAX
          ? "tooMany"
          : size > IMPORT_SIZE_LIMIT
            ? "tooLarge"
            : null;
      setSelection({
        files: error ? [] : files.map(({ path, content }) => ({ path, content })),
        ignored,
        error,
      });
    } catch {
      setSelection({ files: [], ignored: 0, error: "unreadable" });
    } finally {
      setReading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void take(droppedFiles(event.dataTransfer));
  }

  const pickerClasses = cn(buttonClasses("outline", "sm"), "cursor-pointer");
  const ready = selection && !selection.error && selection.files.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <h2 className="text-2xl font-semibold tracking-tight">{t("wiki.importView.title")}</h2>

      <Card className="p-4">
        <WikiDocuments />
      </Card>

      <Card
        className={cn("space-y-4 p-4", dragging && "ring-2 ring-primary")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
      >
        <div className="space-y-1">
          <h3 className="font-semibold">{t("wiki.importView.markdownTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("wiki.importView.description")}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("wiki.importView.joplin")}</li>
            <li>{t("wiki.importView.obsidian")}</li>
          </ul>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className={pickerClasses}>
            <FolderOpen aria-hidden />
            {t("wiki.importView.chooseFolder")}
            <input
              type="file"
              multiple
              className="sr-only"
              // webkitdirectory is not in the React types; every current browser supports it.
              ref={(input) => input?.setAttribute("webkitdirectory", "")}
              onChange={(event) => {
                const picked = pickedFiles(event.target.files);
                event.target.value = "";
                void take(picked);
              }}
            />
          </label>
          <label className={pickerClasses}>
            <FileText aria-hidden />
            {t("wiki.importView.chooseFiles")}
            <input
              type="file"
              multiple
              accept=".md,.markdown,text/markdown,.zip,application/zip"
              className="sr-only"
              onChange={(event) => {
                const picked = pickedFiles(event.target.files);
                event.target.value = "";
                void take(picked);
              }}
            />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{t("wiki.importView.dropHint")}</p>

        {reading ? (
          <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
        ) : null}

        {selection ? (
          <div className="space-y-1 text-sm" aria-live="polite">
            {selection.error === "tooMany" ? (
              <ErrorAlert>
                {t("wiki.importView.tooMany", { max: WIKI_IMPORT_FILES_MAX })}
              </ErrorAlert>
            ) : selection.error === "tooLarge" ? (
              <ErrorAlert>{t("wiki.importView.tooLarge")}</ErrorAlert>
            ) : selection.error === "unreadable" ? (
              <ErrorAlert>{t("wiki.importView.unreadable")}</ErrorAlert>
            ) : (
              <p>{t("wiki.importView.ready", { count: selection.files.length })}</p>
            )}
            {selection.ignored > 0 ? (
              <p className="text-muted-foreground">
                {t("wiki.importView.ignored", { count: selection.ignored })}
              </p>
            ) : null}
          </div>
        ) : null}

        <FormField
          id="wiki-import-section"
          label={t("wiki.importView.section")}
          hint={t("wiki.importView.sectionHint")}
        >
          <Input
            id="wiki-import-section"
            value={section}
            onChange={(event) => setSection(event.target.value)}
            aria-describedby="wiki-import-section-message"
          />
        </FormField>

        {importWiki.isError ? <ErrorAlert>{translateError(t, importWiki.error)}</ErrorAlert> : null}
        {importWiki.isSuccess ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm" aria-live="polite">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t("wiki.importView.result", importWiki.data)}
            <Link to={base} className="text-primary hover:underline">
              {t("wiki.back")}
            </Link>
          </p>
        ) : null}
        {importWiki.data?.secretsRemoved ? (
          <p className="text-sm text-muted-foreground">
            {t("wiki.importView.secretsRemoved", { count: importWiki.data.secretsRemoved })}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            disabled={!ready || importWiki.isPending}
            onClick={() => {
              if (selection) {
                importWiki.mutate(
                  { section: section.trim() || null, files: selection.files },
                  { onSuccess: () => setSelection(null) },
                );
              }
            }}
          >
            {importWiki.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Upload aria-hidden />
            )}
            {t("wiki.importView.submit")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
