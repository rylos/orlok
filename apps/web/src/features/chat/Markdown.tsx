import { slugify, WIKI_LINK_PATTERN } from "@orlok/shared";
import type { Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import { isValidElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

type CodeProps = { className?: string; children?: ReactNode };

// Fenced code blocks arrive as <pre><code class="language-x">: render them with highlighting.
function Pre({ children }: { children?: ReactNode }) {
  if (isValidElement<CodeProps>(children)) {
    const language = /language-([\w#+.-]+)/.exec(children.props.className ?? "")?.[1] ?? null;
    const code = String(children.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock code={code} language={language?.toLowerCase() ?? null} />;
  }
  return <pre>{children}</pre>;
}

const WIKI_PROTOCOL = "wiki:";

// [[slug]] and [[Title|label]] become links with the wiki: protocol (code is left alone).
function remarkWikiLinks() {
  return (tree: Root) => {
    findAndReplace(
      tree,
      [
        [
          new RegExp(WIKI_LINK_PATTERN.source, "g"),
          (_: string, target: string, label: string | undefined) => ({
            type: "link",
            url: `${WIKI_PROTOCOL}${slugify(target)}`,
            children: [{ type: "text", value: (label ?? target).trim() || target }],
          }),
        ],
      ],
      { ignore: ["link", "linkReference"] },
    );
  };
}

function urlTransform(url: string) {
  return url.startsWith(WIKI_PROTOCOL) ? url : defaultUrlTransform(url);
}

type MarkdownProps = {
  children: string;
  // Base path of the office wiki: when set, wiki links are resolved against it.
  wikiBase?: string;
  // Titles of known pages (slug → title), shown for links written without a label.
  wikiTitles?: ReadonlyMap<string, string>;
  // Mark links to pages missing from wikiTitles (only when it lists every page).
  markMissing?: boolean;
};

// Renders model output and wiki pages as Markdown. Raw HTML in the text is not rendered.
export function Markdown({ children, wikiBase, wikiTitles, markMissing = false }: MarkdownProps) {
  const { t } = useTranslation();

  const components: Components = {
    pre: Pre,
    a: ({ href, children: label }) => {
      if (wikiBase && href?.startsWith(WIKI_PROTOCOL)) {
        const slug = href.slice(WIKI_PROTOCOL.length);
        const missing = markMissing && !wikiTitles?.has(slug);
        // [[slug]] without a label: show the page title when it is known.
        const title = label === slug ? wikiTitles?.get(slug) : undefined;
        return (
          <Link
            to={`${wikiBase}/${slug}`}
            className={missing ? "wiki-missing" : undefined}
            title={missing ? t("wiki.missingPage") : undefined}
          >
            {title ?? label}
          </Link>
        );
      }
      return <a href={href}>{label}</a>;
    },
  };

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={wikiBase ? [remarkGfm, remarkWikiLinks] : [remarkGfm]}
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
