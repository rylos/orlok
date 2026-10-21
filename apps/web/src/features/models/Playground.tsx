import type { ChatStreamEvent, ChatTurn, TokenUsage } from "@orlok/shared";
import { Bot, Eraser, Send, Square, User } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { SectionHeader } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { translateError } from "@/i18n/errors";
import { useProfiles } from "@/lib/admin-queries";
import { streamApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Playground() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const [selectedId, setSelectedId] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const profileList = profiles.data ?? [];
  const profileId = selectedId || profileList[0]?.id || "";

  function appendToAnswer(text: string) {
    setTurns((current) => {
      const last = current.at(-1);
      if (last?.role !== "assistant") {
        return current;
      }
      return [...current.slice(0, -1), { ...last, content: last.content + text }];
    });
  }

  function onEvent(event: ChatStreamEvent) {
    if (event.type === "text") {
      appendToAnswer(event.text);
    } else if (event.type === "done") {
      setUsage(event.usage);
    } else if (event.type === "error") {
      setError(`${t(`errors.codes.${event.code}`)}: ${event.message}`);
    }
  }

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !profileId || streaming) {
      return;
    }

    const history = [...turns.filter((turn) => turn.content), { role: "user" as const, content }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setError(null);
    setUsage(null);
    setStreaming(true);

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await streamApi<ChatStreamEvent>(
        "/admin/playground",
        { profileId, messages: history },
        onEvent,
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(translateError(t, err));
      }
    } finally {
      setStreaming(false);
      controllerRef.current = null;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <section aria-labelledby="playground-title" className="space-y-4">
      <SectionHeader
        id="playground-title"
        title={t("models.playground.title")}
        description={t("models.playground.description")}
      />

      {profileList.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("models.playground.needProfile")}
        </p>
      ) : (
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full sm:w-80">
              <FormField id="playground-profile" label={t("models.playground.profile")}>
                <Select
                  id="playground-profile"
                  value={profileId}
                  disabled={streaming}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {profileList.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.model}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={streaming || turns.length === 0}
              onClick={() => {
                setTurns([]);
                setError(null);
                setUsage(null);
              }}
            >
              <Eraser aria-hidden />
              {t("models.playground.clear")}
            </Button>
          </div>

          <div
            className="max-h-[28rem] min-h-40 space-y-3 overflow-y-auto rounded-md border bg-background p-3"
            aria-live="polite"
          >
            {turns.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("models.playground.empty")}
              </p>
            ) : (
              turns.map((turn, index) => (
                <div
                  // Turns are append-only, so the index is a stable key.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  key={index}
                  className={cn("flex gap-2", turn.role === "user" && "flex-row-reverse")}
                >
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full",
                      turn.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-primary",
                    )}
                    title={
                      turn.role === "user"
                        ? t("models.playground.you")
                        : t("models.playground.model")
                    }
                  >
                    {turn.role === "user" ? (
                      <User className="size-4" aria-hidden />
                    ) : (
                      <Bot className="size-4" aria-hidden />
                    )}
                  </span>
                  <div
                    className={cn(
                      "max-w-prose rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                      turn.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-card text-card-foreground",
                    )}
                  >
                    {turn.content || (streaming ? "…" : "")}
                  </div>
                </div>
              ))
            )}
          </div>

          {error ? <ErrorAlert>{error}</ErrorAlert> : null}

          <form onSubmit={send} className="space-y-2">
            <label htmlFor="playground-message" className="sr-only">
              {t("models.playground.message")}
            </label>
            <Textarea
              id="playground-message"
              rows={3}
              value={draft}
              placeholder={t("models.playground.placeholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {usage
                  ? t("models.playground.usage", {
                      input: usage.inputTokens,
                      output: usage.outputTokens,
                    })
                  : null}
              </p>
              {streaming ? (
                <Button variant="outline" onClick={() => controllerRef.current?.abort()}>
                  <Square aria-hidden />
                  {t("models.playground.stop")}
                </Button>
              ) : (
                <Button type="submit" disabled={!draft.trim()}>
                  <Send aria-hidden />
                  {t("models.playground.send")}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
    </section>
  );
}
