import { CONVERSATION_TITLE_MAX } from "@orlok/shared";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translateError } from "@/i18n/errors";
import { useRenameConversation } from "@/lib/workspace-queries";

type RenameConversationProps = {
  colleagueId: string;
  conversationId: string;
  title: string | null;
  // The field is closed: saved, cancelled or left unchanged.
  onDone: () => void;
};

// Inline title field of the open conversation, opened from its menu (Enter saves, Escape
// cancels).
export function RenameConversation({
  colleagueId,
  conversationId,
  title,
  onDone,
}: RenameConversationProps) {
  const { t } = useTranslation();
  const rename = useRenameConversation(colleagueId);
  const [value, setValue] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function save() {
    const next = value.trim();
    if (!next || next === title) {
      onDone();
      return;
    }
    rename.mutate({ id: conversationId, title: next }, { onSuccess: onDone });
  }

  return (
    <form
      className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor="conversation-title" className="sr-only">
        {t("chat.renameLabel")}
      </label>
      <Input
        ref={inputRef}
        id="conversation-title"
        className="h-8 min-w-0 flex-1 sm:w-72"
        maxLength={CONVERSATION_TITLE_MAX}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onDone();
          }
        }}
        aria-invalid={rename.isError}
      />
      <Button size="sm" type="submit" disabled={rename.isPending}>
        {rename.isPending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <Check aria-hidden />
        )}
        {t("chat.save")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        {t("common.cancel")}
      </Button>
      {rename.isError ? (
        <p className="w-full text-sm text-destructive">{translateError(t, rename.error)}</p>
      ) : null}
    </form>
  );
}
