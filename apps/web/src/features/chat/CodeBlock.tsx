import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { highlightCode } from "./highlighter";

type CodeBlockProps = {
  code: string;
  language: string | null;
};

// Delay before highlighting, so a block that is still streaming is not re-rendered at every token.
const HIGHLIGHT_DELAY_MS = 150;

export function CodeBlock({ code, language }: CodeBlockProps) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!language) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      highlightCode(code, language)
        .then((result) => {
          if (!cancelled) {
            setHtml(result);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHtml(null);
          }
        });
    }, HIGHLIGHT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code-block my-3 overflow-hidden rounded-md border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? t("chat.code")}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          {copied ? t("chat.copied") : t("chat.copy")}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[0.8rem] leading-relaxed"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes the code it renders
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[0.8rem] leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
