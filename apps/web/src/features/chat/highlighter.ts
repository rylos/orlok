import type { HighlighterCore, LanguageInput } from "shiki/core";

// Every one of these is rendered at once, as a CSS variable on each token, so that switching the
// UI theme does not require highlighting again — which is also why there are four of them and not
// one per UI theme: each theme picks the closest in `index.css` (R-UI-2).
const SHIKI_THEMES = {
  latte: "catppuccin-latte",
  mocha: "catppuccin-mocha",
  "tokyo-night": "tokyo-night",
  gruvbox: "gruvbox-dark-medium",
} as const;

// Languages useful for IT operations and common development. Each grammar is a separate chunk
// loaded on first use; very large grammars (such as C++) are left out and shown as plain text.
const LANGUAGES = {
  bash: () => import("@shikijs/langs/bash"),
  bat: () => import("@shikijs/langs/bat"),
  c: () => import("@shikijs/langs/c"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  csv: () => import("@shikijs/langs/csv"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  log: () => import("@shikijs/langs/log"),
  markdown: () => import("@shikijs/langs/markdown"),
  nginx: () => import("@shikijs/langs/nginx"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vb: () => import("@shikijs/langs/vb"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<string, LanguageInput>;

type Language = keyof typeof LANGUAGES;

const ALIASES: Record<string, Language> = {
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  cmd: "bat",
  batch: "bat",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  yml: "yaml",
  cs: "csharp",
  "c#": "csharp",
  md: "markdown",
  docker: "dockerfile",
  golang: "go",
  rs: "rust",
  htm: "html",
  tsql: "sql",
  mssql: "sql",
  vbnet: "vb",
};

function resolveLanguage(name: string): Language | null {
  if (Object.hasOwn(LANGUAGES, name)) {
    return name as Language;
  }
  return ALIASES[name] ?? null;
}

let highlighter: Promise<HighlighterCore> | null = null;

// Loaded on first use; the JavaScript regex engine avoids shipping WebAssembly.
function loadHighlighter() {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [
        import("@shikijs/themes/catppuccin-latte"),
        import("@shikijs/themes/catppuccin-mocha"),
        import("@shikijs/themes/tokyo-night"),
        import("@shikijs/themes/gruvbox-dark-medium"),
      ],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

// Highlighted HTML, or null when the language is not supported.
export async function highlightCode(code: string, name: string): Promise<string | null> {
  const lang = resolveLanguage(name);
  if (!lang) {
    return null;
  }
  const instance = await loadHighlighter();
  if (!instance.getLoadedLanguages().includes(lang)) {
    await instance.loadLanguage(LANGUAGES[lang]);
  }
  return instance.codeToHtml(code, { lang, themes: SHIKI_THEMES, defaultColor: false });
}
