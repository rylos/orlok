import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { translateError } from "@/i18n/errors";
import { useDocumentSettings, useProfiles, useSaveDocumentSettings } from "@/lib/admin-queries";

// Reading of office documents: local OCR, plus an optional model with vision.
export function DocumentsSection() {
  const { t } = useTranslation();
  const settings = useDocumentSettings();
  const profiles = useProfiles();
  const save = useSaveDocumentSettings();
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const value = selected ?? settings.data?.visionProfileId ?? "";

  return (
    <section aria-labelledby="documents-title" className="space-y-4">
      <SectionHeader
        id="documents-title"
        title={t("models.documents.title")}
        description={t("models.documents.description")}
      />
      <Card className="p-4">
        {settings.isPending ? (
          <Loader2 className="size-5 animate-spin text-primary" aria-label={t("common.loading")} />
        ) : settings.isError ? (
          <ErrorAlert>{translateError(t, settings.error)}</ErrorAlert>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              save.mutate({ visionProfileId: value || null }, { onSuccess: () => setSaved(true) });
            }}
          >
            <FormField
              id="documents-vision"
              label={t("models.documents.vision")}
              hint={t("models.documents.visionHint")}
            >
              <Select
                id="documents-vision"
                value={value}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setSaved(false);
                }}
                aria-describedby="documents-vision-message"
              >
                <option value="">{t("models.documents.localOnly")}</option>
                {(profiles.data ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </option>
                ))}
              </Select>
            </FormField>
            {save.isError ? <ErrorAlert>{translateError(t, save.error)}</ErrorAlert> : null}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {saved ? (
                <p className="flex items-center gap-1.5 text-sm" aria-live="polite">
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  {t("models.documents.saved")}
                </p>
              ) : null}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("models.documents.save")}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </section>
  );
}
