import type { WikiCandidate } from "@orlok/shared";
import { BookmarkPlus, Check, Lightbulb, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { translateError } from "@/i18n/errors";
import { useWikiCandidate } from "@/lib/workspace-queries";

// What the colleague proposes to keep in the wiki after the conversation went quiet (R-MEM-16).
// Only the person who had the conversation sees it, and nothing is written unless they save it.
export function WikiCandidates({
  conversationId,
  candidates,
  wikiBase,
}: {
  conversationId: string;
  candidates: WikiCandidate[];
  wikiBase: string;
}) {
  const { t } = useTranslation();
  const decide = useWikiCandidate(conversationId);
  // Once the last proposal is decided, the section stays only to say it was saved: after
  // letting it go there is nothing left to show.
  const justSaved = decide.isSuccess && decide.variables?.save === true;
  if (candidates.length === 0 && !justSaved) {
    return null;
  }
  return (
    <section
      aria-labelledby="wiki-candidates"
      className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <h3 id="wiki-candidates" className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb className="size-4 text-primary" aria-hidden />
        {t("chat.wikiCandidates.title")}
      </h3>
      {candidates.length > 0 ? (
        <ul className="space-y-2">
          {candidates.map((candidate, index) => (
            <li
              key={`${candidate.title}\n${candidate.summary}`}
              className="flex flex-wrap items-start justify-between gap-2 text-sm"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-medium">{candidate.title}</p>
                <p className="text-muted-foreground">{candidate.summary}</p>
                {candidate.slug ? (
                  <p className="text-xs text-muted-foreground">
                    {t("chat.wikiCandidates.probably")}{" "}
                    <Link to={`${wikiBase}/${candidate.slug}`} className="text-primary underline">
                      {candidate.slug}
                    </Link>
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ index, save: true })}
                >
                  <BookmarkPlus aria-hidden />
                  {t("chat.wikiCandidates.save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decide.isPending}
                  aria-label={t("chat.wikiCandidates.dismiss")}
                  title={t("chat.wikiCandidates.dismiss")}
                  onClick={() => decide.mutate({ index, save: false })}
                >
                  <X aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {justSaved ? (
        <p className="flex items-center gap-1.5 text-xs" aria-live="polite">
          <Check className="size-3.5 text-success" aria-hidden />
          {t("chat.savedToWiki")}
        </p>
      ) : null}
      {decide.isError ? <ErrorAlert>{translateError(t, decide.error)}</ErrorAlert> : null}
    </section>
  );
}
