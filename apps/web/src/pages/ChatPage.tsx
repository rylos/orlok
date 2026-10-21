import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ChatView } from "@/features/chat/ChatView";
import { translateError } from "@/i18n/errors";
import { findColleague, useWorkspaceOffices } from "@/lib/workspace-queries";

// Conversation with a colleague (R-CHAT-2). Loaded on demand with the Markdown renderer.
export function ChatPage() {
  const { t } = useTranslation();
  const { colleagueId = "", conversationId } = useParams();
  const offices = useWorkspaceOffices();

  if (offices.isPending) {
    return (
      <div className="grid flex-1 place-items-center">
        <Loader2 className="size-6 animate-spin text-primary" aria-label={t("common.loading")} />
      </div>
    );
  }

  const found = findColleague(offices.data, colleagueId);
  if (offices.isError || !found) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-sm space-y-4 text-center">
          <ErrorAlert>
            {offices.isError ? translateError(t, offices.error) : t("chat.notFound")}
          </ErrorAlert>
          <Link to="/" className={buttonClasses("outline", "sm")}>
            <ArrowLeft aria-hidden />
            {t("chat.back")}
          </Link>
        </div>
      </div>
    );
  }

  // Keyed by colleague so switching conversations keeps an answer that is still streaming.
  return (
    <ChatView
      key={found.colleague.id}
      office={found.office}
      colleague={found.colleague}
      archived={found.archived}
      conversationId={conversationId}
    />
  );
}
