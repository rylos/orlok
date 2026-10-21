# Orlok

A self-hosted platform (one installation per company, Docker) of **virtual colleagues** organized into **offices**:

- **Web admin**: offices, people and the colleague profiles granted to them, email invitations, model providers and keys (Anthropic, OpenAI, Ollama…).
- **User area** (desktop and mobile): your own virtual colleagues in each of your offices, chat with them, persistent sign-in, light and dark themes, multiple languages.
- **Memory** per office and per colleague, managed as a self-maintained wiki (ingest / query / lint).
- **Real operations**: interventions on servers (SSH / PowerShell Remoting) and clients (agent module), with each person's own credentials, modes from the colleague's profile, approvals and audit.

Requirements and decisions: **[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)**.

Orlok is source-available and free for personal use, under the [Business Source License 1.1](LICENSE); see [License](#license).

## Layout

```
apps/server      Hono API + agent runtime (Node, TypeScript, Drizzle/Postgres)
apps/web         admin and user interface (React, Vite, Tailwind, shadcn/ui)
apps/runner      isolated container that runs commands, SSH sessions and local MCP servers
packages/shared  shared code (types, schemas, themes, languages, error codes)
docs             requirements and documentation
demo             fictional demo installation, its seed and screenshots (website, presentations)
```

## Development

Prerequisites: Node ≥ 22.12, pnpm 11, Docker with Compose.

```bash
pnpm install
cp .env.example .env   # then set ORLOK_SECRET_KEY: openssl rand -base64 32
pnpm db:up          # Postgres + pgvector (compose.dev.yaml)
pnpm dev            # server on :3000, web on :5173 on every interface (proxy /api → server),
                    # runner on 127.0.0.1:3100 (development token, no per-job uid isolation)
```

`pnpm install` also points git at `.githooks`, whose `pre-push` refuses to delete or force-push `main` (GitHub protects branches of private repositories only on paid plans). Use `--no-verify` to bypass it on purpose.

In development the runner does not read `.env`. It uses its built-in token, `orlok-dev-runner-token`, so `ORLOK_RUNNER_TOKEN` in `.env` must keep that value.

On Windows `pnpm dev` stops at the runner, whose script sets variables the POSIX way, so start the parts separately:

```bash
pnpm --filter @orlok/server dev
pnpm --filter @orlok/web dev
```

From Git Bash the runner also starts:

```bash
NODE_ENV=development HOST=127.0.0.1 pnpm --filter @orlok/runner exec tsx watch src/index.ts
```

On Windows that runner accepts jobs but cannot run them, because it needs a POSIX shell. To try operations, run the runner from its Docker image, as in production.

The dev server also answers on the LAN address of the machine (e.g. `http://<lan-ip>:5173`); set `ORLOK_PUBLIC_URL` to that address so invitation links work from other devices. On first visit to http://localhost:5173 the **first-run setup** asks for the company name and the administrator account. Database migrations are applied automatically when the server starts.

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm check` | Biome: verify / fix formatting and lint |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Vitest across all packages (the server needs Postgres: run `pnpm db:up` first) |
| `pnpm build` | build server (tsdown) and web (Vite) |
| `pnpm --filter @orlok/server db:generate` | generate Drizzle migrations |

## Production (Docker)

`compose.yaml` runs the whole installation: `db` (Postgres 18 + pgvector, named volume `db-data`; user and database `orlok` unless `POSTGRES_USER` / `POSTGRES_DB` say otherwise), `app` (the root `Dockerfile`: API, background workers and the built web app on one port) and `runner` (`apps/runner/Dockerfile`, no published ports, not on the database network).

```bash
cp .env.production.example .env.production   # fill in the secrets (generation hints inside)
docker compose --env-file .env.production up -d --build
```

- Only the app publishes a port (`ORLOK_PORT`, default 8080). Migrations apply at start; the first visit opens the first-run setup.
- The foot of the menu shows the image the server is running, because a container cannot read its own tag: compose passes `ORLOK_APP_IMAGE` in as `ORLOK_IMAGE`. Nothing is shown when it is unset, as in development.
- Deploying replaces the files of the web app, which are named after their contents: a page left open from the previous build loads itself again the first time it needs a piece that no longer exists, rather than failing on it.
- The image contains everything the server needs offline: production dependencies installed with pnpm inside the image, the built-in embedding model (fetched and verified at build time), OCR data for Italian and English. It runs as a non-root user under tini with a read-only root filesystem; `/tmp` is the only writable path.
- `ORLOK_PUBLIC_URL` must be the address people use. A reverse proxy in front (TLS) must forward `X-Forwarded-Host` and `X-Forwarded-Proto`, otherwise the CSRF check rejects every upload.
- Back up the `db-data` volume (`orlok_db-data`) and `ORLOK_SECRET_KEY` (without it saved provider keys and credentials cannot be decrypted).
- Installing the app on phones and web push notifications need https (browsers allow service workers only in secure contexts). Over plain http on a LAN address Orlok works fully, and notifications arrive by email. Session cookies are marked `Secure` only when `ORLOK_PUBLIC_URL` is https.

## Operations

Virtual colleagues can act on real systems, modelled on OpenClaw's exec approvals (R-OPS):

- **Runner** (`apps/runner`): a separate container with network and command line tools (ping, dig, ssh, nmap, psql, sqlcmd, openssl, snmpwalk, ldapsearch, smbclient, PowerShell 7…). Colleagues are told the tools it really has; a company adds its own by building a derived image (`FROM orlok-runner`, see `apps/runner/README.md`), never by installing at run time. The server talks to it over an internal HTTP API with `ORLOK_RUNNER_URL` / `ORLOK_RUNNER_TOKEN`; without them operations are disabled. Local jobs and MCP servers run under a dedicated uid with resource limits; see `apps/runner/README.md` for the container settings (read-only root, `cap_drop: ALL` + `SETUID`/`SETGID`/`NET_RAW`, exec tmpfs on `/tmp`).
- **Hosts** (*Admin → Hosts*): one registry for the whole installation. A host is a machine reached through SSH (OpenSSH on Windows too) or, for Windows, WinRM over http (encrypted by NTLM or Kerberos) or https, and nothing more — name, address, port, system, connection. WinRM takes password credentials only. The host key is the machine's, trusted on the first connection that gets in and then enforced whichever credential is used. Two hosts at the same address are flagged: that is one machine entered twice.
- **Credentials** (*Account → Credentials*): each person stores their own accounts, encrypted with `ORLOK_SECRET_KEY` and handed only to the runner, and chooses the hosts each one is used on, one credential per host. A colleague working for someone reaches only the hosts where that person has a credential and acts there as that person, so the servers themselves decide what it may do, and it can neither see the credential nor choose another — a refusal is a refusal, not an invitation to retry with a stronger login. Asked to work on a host where the person has no credential, the colleague says so in a sentence or two and points them to *Account → Credentials*, named in their language, never asking for a password in the chat; it does not mention the runner to them. The credential is read when the command runs, so one removed while an approval waits is already gone. Saving a credential tests it on its hosts, and each test shows which account answered. Disabling a person deletes their credentials; events about hosts and credentials go to the installation log in *Admin → Operations*.
- **Modes** come from the colleague's profile (*Admin → Colleague profiles*): deny (no commands), ask (built-in read-only commands and the command types the person asking approved for good run immediately, the rest waits for approval), full access (no approvals, dangerous commands stay blocked) and yolo (no approvals, dangerous commands run too). Commands are parsed (POSIX shell and PowerShell), never matched as plain text.
- **No per-colleague policy**: hosts come from the credentials of the person asking, the mode from the profile, and the runner and the office's MCP servers are there in every mode but deny.
- **Approvals** wait in a strip between the conversation and the message box, one at a time, oldest first: approve once, always or deny. A command line is split into its pieces, each with a **type**: the program and the one to three words after it that say what it does, so `systemctl restart nginx && systemctl status nginx` is a read plus `systemctl restart`, and only the type still missing is asked. "Always" approves those types for the person it was asked for, with all their colleagues, on every host and on the runner, and for nobody else: the judgement behind it is theirs. `sudo` makes a type of its own (`sudo systemctl restart`), and a file written with `>` is the type `>`. A command that cannot be read to the end — `$(...)`, `bash -c`, a script, a command run through `ssh`, a key or password file read — has no type to remember and is approved once each time, as is an MCP tool. A PowerShell command is read as a script: variables, `if`, `foreach`, `try`, hashtables and the functions it defines are followed into, every command inside them is a piece like the others, and an expression may call only the .NET methods and types known to compute or read; any other method, a property set or a special variable makes it once only. Why a command waits, can be approved only once or was refused is shown in the person's language, while the colleague is told in technical English what to change. Everyone reviews, turns off and removes their own types in *Account → Approved command types*; an administrator sees them per person in *Admin → People* and can turn one off for good, so it asks every time until an administrator turns it on again. Turning types off, on or away goes to the installation log. Only the person the intervention was asked for sees it, decides it and stops it, administrators included, since the conversation it belongs to is theirs alone. A request never expires: it waits in the strip until it is decided, however long that takes, and asking a colleague for the same command again while the first request is still waiting joins that request instead of adding a second one to decide. A late approval runs the job and the colleague reports the result in a follow-up message. Just before running, a job is judged again with the profile, the command types and the MCP tools of that moment: if it would now need more than what was granted, it does not run, and changing a colleague's profile cancels what still waits. A plan is approved as a whole from the strip, which shows the commands of its steps and can also always allow the types of the steps that can be read to the end, or step by step from its card, once or always; an MCP call is shown with its whole input. Output is live, can be stopped, and has likely secrets masked.
- **Commands in the answer**: an answer is stored as the parts it is made of, so each command card sits where the answer paused to run it, and folds into one line once it ends unless it went wrong. The commands of the last three answers come back to the colleague with the history — status, exit code and a cut of their output, and separately the ones still waiting for a decision — so it knows what its own commands did instead of relying on its retelling of them, and does not ask again for something already waiting.
- **MCP servers** per office, used by every colleague of the office: remote (streamable HTTP, secret headers) or local commands inside the runner (stdio, secret environment variables). Tools are offered as `mcp__<server>__<tool>`; read-only tools run immediately, the others follow the server's tool policy.
- **Plans**: for a change made of several commands a colleague proposes a plan (`ops_plan`); people approve the whole plan or each step, steps run in order and a failed step stops the rest.
- **Notifications**: they go to the person the intervention was asked for and to nobody else, both when an approval is waiting and when a late intervention ends, because the job card lives in a conversation only that person can open. Each person chooses in *Account*, where signed-in devices can also be signed out.
- **Audit**: every change and job is recorded in an append-only log, without secrets. Administrators export the whole log, installation and offices, as CSV or JSON Lines from *Admin → Operations*.
- **Restarts**: a command running when Orlok restarts may have run in full, in part or not at all (the runner is a separate container). It is never run again by itself: its plan stops, and the person and the colleague are told to check the state before trying again.

## Offices and colleagues

Administrators create **offices** at `/admin/offices` and grant people **colleague profiles** (a model and a mode) in *Admin → People*, themselves included: creating a profile grants it to nobody. Each person creates their own **virtual colleagues** with the **+** next to an office in the side list: name, role and instructions (both optional) and one of their profiles (required: chosen for them only when they hold just one; without any, the side list says whom to ask). Colleagues are private: nobody else sees them, administrators included. A colleague whose profile is taken away waits for its owner to choose another, never switched automatically since the other profile may allow more (when only one is left, its settings have it chosen already, one click away); archiving hides it and keeps its conversations; deleting removes its conversations and keeps only its name, so the wiki still says who wrote what. Each conversation belongs to one person, is stored with its messages and is streamed while the colleague answers. On a computer the conversations opened with a colleague stay as tabs until they are closed, in the order they are dragged to, remembered by the browser: another tab can be opened while an answer is still being written, since the server goes on writing it, and a tab not in view shows a red dot while a command of its conversation waits for approval; the list of conversations marks those as "Title ●", with a red dot on the closed list. The open tab keeps its close button and a "⋯" menu to rename or delete the conversation. The context meter under the message box says how full the model's window is before the conversation gets summarized. Enter sends (on a phone, the send button); what is sent while the colleague is still answering is queued above the box, where each message can be taken back to change it or dropped, and goes as one message when the answer ends, while Stop gives the queue back to the box. The colleague's system prompt includes the company, office, colleague role, the person's name and language, the instructions its owner wrote and, where commands are possible, how it may run them: the approvals of its mode, or why it cannot (a deny profile, no credential of the person on a host) and what the person can change.

## Office wiki

Every office has a **wiki** (`/offices/<id>/wiki`), its shared memory: Markdown pages with a title, section, type and sources, linked with `[[link-name]]` or `[[link-name|text]]`. Everyone in the office reads it; administrators and office managers create, edit, delete and restore pages. Every save is kept as a revision, concurrent edits are detected, backlinks are listed on each page and all changes go to the office log. Search is full-text and works across accents and word forms.

Before answering, a colleague receives the list of pages in the wiki and the pages that best match the latest message, and cites the pages it uses; the web app shows the consulted pages under the answer. Wikis are strictly separated: nothing is shared or searched across offices.

Each colleague also keeps **private notes** about working with its owner — preferences, working context — read at the start of every conversation with them and shown only to them, in the colleague's settings.

Virtual colleagues maintain the wiki themselves, the way an assistant keeps a personal wiki: with the tools `wiki_search`, `wiki_read` and `wiki_write` they consult it while answering and, when a conversation teaches them something durable, decide on their own to update or create pages (reading a page before replacing it, linking related pages, never storing secrets). Every change is a revision authored by the colleague, listed under the answer and in the office log, and the history of a page says where each one came from: a conversation, with the commands run there, or a document. A colleague working for someone who may not edit the wiki proposes its changes instead: they wait in the review queue until an office manager applies or dismisses them. The structural lint runs every night for every office.

Office documents (PDF, Word, Excel, PowerPoint, OpenDocument, HTML, CSV, text…) are uploaded from the wiki import page and filed in the background by one of the uploader's own colleagues in that office: the text is extracted, then the colleague writes a source page summarizing the document and updates or creates the topic pages it touches, linked together. Likely passwords and keys are removed from the extracted text before any model reads it, and the document says how many. The original file and the extracted (redacted) text are kept, so a document can be read and filed again; the same file is imported only once per office.

Scanned pages, images and pictures inside documents are read locally with OCR (Tesseract, Italian and English, no network needed), and unreadable words are marked `[illegible]` instead of guessed. Administrators can also choose, at `/admin/models`, a model that supports images: it then transcribes scanned pages and describes figures and screenshots for better quality, which means those images are sent to its provider.

Pages are connected by a relevance model: direct links (×3), shared sources (×4), common neighbors weighted by Adamic-Adar (×1.5), same page type (×1) and, when embeddings are available, semantic similarity (×2). The wiki shows related pages on every page and an interactive knowledge graph (sigma.js, Louvain communities) with insights: surprising connections, bridge pages, isolated pages and loosely linked topics. Colleagues retrieve context with full-text search, semantic search (pgvector) and a two-hop expansion over the graph.

Documents are filed in two steps (analysis against the related pages, then writing with the tools); every document gets a source page, the office overview page is kept current and colleagues raise contradictions, missing pages and open questions into the office review queue, next to the structural lint findings (isolated pages, loosely linked topics, links to missing pages). Each office wiki has a purpose that colleagues read to decide what is worth keeping. Removing a document can also remove the pages written only from it (shared pages just lose the source, links to deleted pages are cleaned up), and any answer in a conversation can be saved to the wiki.

Semantic memory needs embeddings: a built-in multilingual model runs inside the server image, or administrators can choose an OpenAI-compatible provider (Ollama with Qwen3-Embedding or BGE-M3, OpenAI…) at `/admin/models`.

Existing documentation can be imported from Markdown files: folders become sections, frontmatter (`title`, `type`, `section`, `sources`, `slug`) is read and relative links between files become wiki links. For Joplin use *File → Export all → MD - Markdown + Front Matter*; an Obsidian vault can be imported as it is. Importing again updates the pages with the same link name.

## Telegram

An administrator sets the installation's bot in *Admin → Email* with a token from @BotFather; Orlok reads its messages by long polling, so nothing has to be reachable from the internet. Each person links their own Telegram account from *Account → Notifications* with a one-time link (15 minutes); from then on approvals and finished interventions also arrive on Telegram, an approval can be allowed once, allowed always (its command types, for that person only, as in the app) or denied with its buttons, and a plan approved, approved always allowing its steps' types, or denied; MCP tools and what the app approves once each time are decided in the app, and writing to the bot talks with the person's own colleagues in ordinary conversations, visible in the web app as well. `/colleague` chooses the colleague, `/new` starts a new conversation, `/conversations` lists the latest ones to continue or delete, after a confirmation. Orlok sets the bot's command menu when it starts: the commands are English in every language, their descriptions translated. Groups are ignored: conversations are private.

## People and email

Administrators invite people at `/admin/people`: email, role, language and the offices they join with a role in each. Administrators work in every office, so none are chosen for them, and promoting someone removes their offices. The invitation email contains a link valid for 7 days (`/invite/<token>`) where the person chooses a name and password; the link is also shown to the administrator when email is not configured or fails, so it can be shared, and only on request once the email has left. Administrators can resend or revoke invitations, change roles and office memberships, and disable access (sessions end immediately, and an open app goes back to sign-in, saying why, at its next request). A member without an office is marked *No office* and counted next to *People* in the admin menu, since they can sign in but do nothing; people without profiles are marked *No profiles*.

The SMTP server is configured at `/admin/email` (host, port, STARTTLS/TLS/none, optional authentication, sender) and can be checked with a test email; its password is encrypted like provider keys. Links in emails use `ORLOK_PUBLIC_URL`.

## Models

Administrators configure **providers** (Anthropic or Anthropic-compatible proxies, OpenAI, OpenAI-compatible servers, Ollama) at `/admin/models`, where they can also try a profile in the playground, and **colleague profiles** at `/admin/profiles`. Every model call is written to a usage ledger; *Admin → Costs* (`/admin/costs`) shows the spend of a month by office, person, model and purpose, sets the price of each model of a per-token provider (US dollars per million tokens; local models and subscriptions are *included*) and sets monthly limits for the installation, an office or a person, checked before every call. A call whose model has no price is counted as *unpriced*, never as free. Provider API keys are encrypted at rest with `ORLOK_SECRET_KEY`, which never lives in the database: keep it safe and back it up, because without it saved keys cannot be decrypted.

## Languages

English (reference and default) and Italian. Translations live in `apps/web/src/i18n/locales/`: every language has exactly the English keys, enforced by TypeScript. The user's language is stored in their profile; before sign-in the browser language is used. APIs return error codes that the interface translates.

## Themes

Ten themes, chosen from the personal menu in the header (the circle with the person's initials, which also holds the account, the language, the administration and signing out): **Catppuccin Latte**, **Rosé Pine Dawn** and **Tokyo Night Light** (light), **Catppuccin Mocha**, **Tokyo Night**, **Nord**, **Gruvbox**, **Everforest**, **Kanagawa** and **Matte Black** (dark), plus "follow system", which uses Latte by day and Mocha by night. Palettes are the ones the original projects ship, most of them as packaged by [Omarchy](https://omarchy.org); the colors that carry meaning — error, warning, info, success — are the ones each theme's own Neovim port assigns to its diagnostics, rather than a guess from the hue. Colors are CSS tokens in `apps/web/src/index.css`: components never use hard-coded colors. Syntax highlighting keeps four Shiki themes, each UI theme picking the closest, because every one of them is rendered on each token at once.

From the keyboard, **Ctrl+K** (⌘K on a Mac) or the search button in the header opens a command palette on any page: it finds commands, colleagues, the open colleague's conversations and the pages of the wiki of the office in view; the arrows choose, Enter opens, Esc closes. The focus crosses the conversation tabs with the arrow keys, Enter opens a tab and Ctrl+Shift+← / → moves it, and whatever the keyboard reaches shows a focus outline.

## License

Orlok is **source-available**, not open source: the code is public under the [Business Source License 1.1](LICENSE).

- **Free** for personal use (yourself, at home or on your own devices, or to learn), for non-profit organizations and for schools and universities (teaching and research). Development, testing and evaluation are free for everyone.
- **Companies** using Orlok in production, for themselves or for clients (self-employed professionals and managed service providers included), need a commercial license: write through [orlok.xyz](https://orlok.xyz/#contact).
- **Four years** after its release, each version becomes available under the Apache License 2.0.

The name and the logo are not covered by the license. Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
