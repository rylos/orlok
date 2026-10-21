# Tech stack

- pnpm 11 monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`); Node ≥ 22.12
- TypeScript 6 (not 7: ecosystem not aligned yet); `tsconfig.base.json` with `module: preserve` + `moduleResolution: bundler`, `noEmit`; no `.js` extensions in imports
- `@orlok/shared` exports `.ts` sources directly (no build): the server bundles them via tsdown `deps.alwaysBundle` (`noExternal` is deprecated), the web via Vite
- `@orlok/shared` root = types, constants, guards (no runtime zod import); zod schemas live in `@orlok/shared/schemas` and are imported only by the server. Importing schemas from the root would pull zod into the web bundle (>500 kB warning)
- Web code-splitting: admin pages use react-router `lazy` routes
- Server: Hono 4 + @hono/node-server, dev with tsx watch, build tsdown → `dist/index.mjs`; Drizzle ORM + postgres-js; Postgres 18 + pgvector; zod 4 + @hono/zod-validator; @node-rs/argon2; pg-boss planned for durable jobs
- LLM: official SDKs behind `apps/server/src/llm/` (`LlmClient`: `listModels`, `streamChat`): `@anthropic-ai/sdk` for kind `anthropic` (also Anthropic-compatible proxies via root `baseURL`), `openai` for `openai`/`openai_compatible`/`ollama` (Ollama default `http://localhost:11434/v1`). Not Vercel AI SDK. MCP TypeScript SDK planned
- Anthropic-compatible gateways (e.g. Meridian): kind `anthropic`, any API key. Meridian honors system prompts; without one it answers as "Claude Code"; unknown model ids silently fall back to its default model instead of erroring
- Secrets at rest: AES-256-GCM (`apps/server/src/lib/crypto.ts`, format `v1:iv:tag:data`) with `ORLOK_SECRET_KEY` (base64, 32 bytes) from env
- Web: React 19, Vite 8, Tailwind 4 (`@tailwindcss/vite`, no tailwind.config), shadcn/ui style (new-york, alias `@/`), lucide-react, react-router 8 (`createBrowserRouter`), TanStack Query 5, i18next 26 + react-i18next 17
- Themes: the palettes listed in `packages/shared/src/theme.ts` (source of truth), CSS tokens per `[data-theme="<id>"]` in `apps/web/src/index.css` mapped in `@theme inline`; `.dark` class for dark themes. Palettes are the originals as packaged by Omarchy (repo `omacom/omarchy`, default branch `quattro`, one `colors.toml` per theme); the palette's violet is the `--primary` (unless it cannot carry text: Matte Black and Tokyo Night Light use their own accent; Tokyo Night uses its blue `#7aa2f7`, the accent of the original theme, since 2026-10-11, because with the violet it could not be told from Catppuccin Mocha, R-UI-2). `--destructive`, `--warning`, `--info` and `--success` are the colours the theme's own Neovim port gives `DiagnosticError/Warn/Info/Ok` — look there rather than picking by hue; Tokyo Night sets no `DiagnosticOk`. Syntax highlighting keeps only four Shiki themes, each UI theme pointing at the closest, because all of them are rendered on every token at once
- Lint/format: Biome 2 (`biome.json`, `preset: recommended`, Tailwind directives enabled)
- Tests: Vitest (server integration tests on a real Postgres test DB)
- Client module (R-OPS-8): Rust, not started yet (decided 2026-10-19; the empty Go stub was removed)
- Deploy: Docker Compose (`compose.yaml`: project `orlok`, Postgres user and database from `POSTGRES_USER` / `POSTGRES_DB`, default `orlok`)

