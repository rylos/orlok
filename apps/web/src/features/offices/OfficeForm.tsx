import type { Office } from "@orlok/shared";
import { Building2, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormHeading } from "@/components/ui/form-heading";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { translateError, translateFieldErrors } from "@/i18n/errors";
import { useSaveOffice } from "@/lib/admin-queries";

export function OfficeForm({ office, onDone }: { office?: Office; onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSaveOffice();
  const [name, setName] = useState(office?.name ?? "");
  const [description, setDescription] = useState(office?.description ?? "");

  const errors = translateFieldErrors(t, save.error);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const id = (field: string) => `office-${office?.id ?? "new"}-${field}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, description: description.trim() || null };
    if (office) {
      save.mutate({ id: office.id, input }, { onSuccess: onDone });
    } else {
      save.mutate({ input }, { onSuccess: onDone });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormHeading icon={Building2}>
        {office ? t("common.editing", { name: office.name }) : t("offices.add")}
      </FormHeading>
      {save.isError && !hasFieldErrors ? (
        <ErrorAlert>{translateError(t, save.error)}</ErrorAlert>
      ) : null}
      <FormField id={id("name")} label={t("offices.name")} error={errors.name}>
        <Input
          id={id("name")}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={Boolean(errors.name)}
        />
      </FormField>
      <FormField
        id={id("description")}
        label={t("offices.officeDescription")}
        error={errors.description}
      >
        <Textarea
          id={id("description")}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-invalid={Boolean(errors.description)}
        />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("offices.save")}
        </Button>
      </div>
    </form>
  );
}
