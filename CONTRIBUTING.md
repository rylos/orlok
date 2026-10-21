# Contributing to Orlok

Contributions are welcome: bug reports, ideas and pull requests.

- **Issues.** Say what you did, what you expected and what happened, with the Orlok version shown at the foot of the menu. Never paste passwords, keys, tokens or other secrets, nor data of your company.
- **Pull requests.** Keep each one to a single change and describe why it is needed. Before opening it, run `pnpm lint`, `pnpm typecheck` and `pnpm test` (see [Development](#development)). Requirements have stable IDs in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): mention the one your change is about.
- **Language.** Code, comments, documentation and commit messages are in English; only the translation files are in other languages.
- **Examples and tests** use made-up names, `example.com` and private or documentation addresses, never real people, companies or systems.

By submitting a contribution you agree that it is published under the project's [license](LICENSE), like the rest of the code.

## Development

Prerequisites: Node ≥ 22.12, pnpm 11, Docker with Compose.

```bash
pnpm install
cp .env.example .env   # then set ORLOK_SECRET_KEY: openssl rand -base64 32
pnpm db:up          # Postgres + pgvector (compose.dev.yaml)
pnpm dev            # server on :3000, web on :5173 on every interface (proxy /api → server),
                    # runner on 127.0.0.1:3100 (development token, no per-job uid isolation)
```

On first visit to http://localhost:5173 the first-run setup asks for the company name and the administrator account. Database migrations are applied when the server starts. The dev server also answers on the machine's LAN address; set `ORLOK_PUBLIC_URL` to it so invitation links work from other devices.

`pnpm install` also points git at `.githooks`, whose `pre-push` refuses to delete or force-push `main`. Use `--no-verify` to bypass it on purpose.

In development the runner does not read `.env`. It uses its built-in token, `orlok-dev-runner-token`, so `ORLOK_RUNNER_TOKEN` in `.env` must keep that value.

On Windows `pnpm dev` stops at the runner, whose script sets variables the POSIX way, so start the parts separately:

```bash
pnpm --filter @orlok/server dev
pnpm --filter @orlok/web dev
```

From Git Bash the runner also starts (`NODE_ENV=development HOST=127.0.0.1 pnpm --filter @orlok/runner exec tsx watch src/index.ts`), but it cannot run jobs without a POSIX shell: to try operations, run the runner from its Docker image.

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm check` | Biome: verify / fix formatting and lint |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Vitest across all packages (the server needs Postgres: run `pnpm db:up` first) |
| `pnpm build` | build server (tsdown) and web (Vite) |
| `pnpm --filter @orlok/server db:generate` | generate Drizzle migrations |

### Layout

```
apps/server      Hono API + agent runtime (Node, TypeScript, Drizzle/Postgres)
apps/web         admin and user interface (React, Vite, Tailwind, shadcn/ui)
apps/runner      isolated container that runs commands, SSH sessions and local MCP servers
packages/shared  shared code (types, schemas, themes, languages, error codes)
docs             requirements and design notes
demo             fictional demo installation, its seed and screenshots
```

How the product works is documented at [orlok.xyz/docs](https://orlok.xyz/docs); requirements and decisions are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
