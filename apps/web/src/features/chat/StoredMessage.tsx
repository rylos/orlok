import type { ConversationMessage } from "@orlok/shared";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { MessageBubble } from "./MessageBubble";

type StoredMessageProps = {
  message: ConversationMessage;
  officeId: string;
  wikiBase: string;
  // Null when the answer cannot be filed into the wiki.
  conversationId: string | null;
};

// A message already stored, drawn again only when it changes. Every key typed in the message box
// re-renders the chat, and redrawing hundreds of answers (their Markdown, tables, code) made typing
// lag in long conversations; the query keeps unchanged messages as the same objects.
export const StoredMessage = memo(function StoredMessage({
  message,
  officeId,
  wikiBase,
  conversationId,
}: StoredMessageProps) {
  const { t } = useTranslation();
  return (
    <MessageBubble
      author={message.role}
      content={message.content}
      status={message.status}
      errorText={message.errorCode ? t(`errors.codes.${message.errorCode}`) : null}
      wikiBase={wikiBase}
      wikiPages={message.wikiPages}
      wikiEdits={message.wikiEdits}
      officeId={officeId}
      parts={message.parts}
      attachments={message.attachments.map((item) => ({
        key: item.id,
        fileName: item.fileName,
        kind: item.kind,
        url: `/api/attachments/${item.id}`,
      }))}
      saveTarget={conversationId ? { conversationId, messageId: message.id } : null}
    />
  );
});
