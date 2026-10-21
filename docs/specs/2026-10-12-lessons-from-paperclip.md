# Lessons from Paperclip — improvement spec

> Status: **phase 1 (spec)**, 2026-10-12. Wave 1 and the blocks chosen by the user in §2b are
> implemented with this document; wave 2 and the rejected ideas are recorded so they are not
> re-proposed without a new reason.

## 0. What Paperclip is, and what it is not for Orlok

[Paperclip](https://github.com/paperclipai/paperclip) (MIT, analysed at `1b4c803`, 2026-10-11) is
a control plane for autonomous AI organisations: companies with an org chart of agents (Claude
Code, Codex, Cursor… driven as external CLI "harnesses"), tasks they wake up for on heartbeats,
budgets, approvals, routines, skills, connectors and a plugin system. Scale: ~1,000 routes, 276
tables, 332 migrations, ~2,500 test files; `heartbeat.ts` alone is 5,300 lines.

Orlok solves a narrower problem: a person's own virtual colleagues, in a chat, acting **as that
person** on the company's systems. So most of Paperclip's machinery (heartbeats, org chart,
delegation trees, liveness classifiers, harness adapters, plugins) does not transfer, and some of
it Paperclip itself had to reverse (productivity reviews, mention wakes, instruction revisions,
recovery loops that re-woke agents every 30 seconds). What transfers is a set of **contracts**:
how usage and money are accounted, how side effects of unknown outcome are handled, how exports
are made safe, how scheduled work is owned.

Where Orlok is already ahead, nothing is taken: wiki search (Paperclip's wiki plugin searches
with `LIKE` on titles), memory privacy (Paperclip's "personal" wiki spaces and agent chats are
declared but not enforced), the approval model by command type, per-person credentials.

## 1. Principles taken

1. **Unknown is never zero.** A model call whose price is not known is recorded as *unpriced*,
   never as free; a command whose outcome is not known is *interrupted, outcome unknown*, never
   simply failed.
2. **Money is attributed at the source and never recomputed.** Each model call writes one ledger
   row with the prices it was charged at; changing a price later does not rewrite the past.
3. **The person a colleague works for is on every row** (Paperclip's `responsibleUserId`): cost,
   jobs, audit. Orlok already does this for jobs and audit; the ledger adds it for money.
4. **Side effects are never replayed blindly.** After a restart, a command that may have run is
   reported to the person and the colleague as of unknown outcome, to be checked before retrying.
5. **Exports are data, not formulas.** Any spreadsheet export neutralises cells that a
   spreadsheet would execute.

## 2. Wave 1 — implemented now

### W1.1 Model usage ledger (R-MOD-4, first half)

Every model call the server makes — chat turns (every step of the tool loop), compaction of long
conversations, document filing, proposals from quiet conversations, critical reading, image
transcription, playground — writes one row to `model_usage`:

| column | meaning |
|---|---|
| `office_id`, `user_id`, `colleague_id`, `conversation_id` | attribution; all nullable, `set null` on delete so spend survives deletions |
| `purpose` | `chat`, `compaction`, `wiki_filing`, `wiki_reflection`, `wiki_check`, `vision`, `playground` |
| `provider_id`, `provider_name`, `model` | name copied, so a deleted provider still reads |
| `input_tokens`, `cached_input_tokens`, `cache_write_tokens`, `output_tokens` | as the provider reported them; input excludes the cached parts |
| `cost_status` | `priced`, `included` (local or subscription models), `unpriced` |
| `cost_micros` | cost in millionths of a US dollar (bigint), null unless `priced` |
| `prices` | the per-million rates applied, copied at write time |

- Usage is taken from the provider's own response, step by step, by wrapping the `LlmClient`
  (`llm/metered.ts`): no call site can forget it, and a turn interrupted by Stop still records the
  steps that ran. A provider that reports no usage records a row with zero tokens and status
  `unpriced` (the call happened; what it cost is unknown).
- A failure writing the ledger is logged and never fails the answer (Paperclip's run-log rule).
- Embeddings are not metered: the default embedder is local, and provider embedding APIs return
  no usage through our adapter. Written down so it is not mistaken for zero.

**Prices** live on the provider, never in code: Paperclip keeps dated price tables in its source
and still prices only one Anthropic model; Orlok talks to any OpenAI- or Anthropic-compatible
server (Meridian, Ollama, vLLM), whose prices no table can know.
- A provider is billed *per token* or *included* (local models, subscriptions such as Meridian).
  New Ollama providers start as included, the others per token.
- A per-token provider has a price per model: input, cached input, cache write, output, in US
  dollars per million tokens. A model without one makes its calls `unpriced`, and *Admin → Costs*
  lists them with the number of calls waiting for a price.
- A price applies from the moment it is saved; the calls before it stay unpriced. Re-pricing the
  past was rejected: the ledger would stop being a record of what was known when it was written.

### W1.2 Spending limits (R-MOD-4, second half)

Administrators set monthly limits (calendar month, UTC) in *Admin → Costs*: one for the whole
installation, one per office, one per person. Each has a warning threshold (default 80 %).

- **Checked before every model call**, not once per turn: a long tool loop or a document being
  filed stops at the next call once a limit is reached. This gives a real hard stop without
  Paperclip's reservations, which exist because its runs are external processes it cannot
  interrupt; Orlok makes each call itself, so at most one call overshoots.
- A call is refused when the installation, the office it belongs to or the person it is made for
  has reached its limit. The answer ends with the error `budget_exceeded`, translated in the chat
  ("the monthly spending limit has been reached, ask an administrator"); a document being filed
  fails with the same code and can be filed again later. A command already running finishes.
- Crossing the warning threshold or the limit notifies administrators once per limit and month
  (email/push, like approvals) and is written to the installation log.
- **Unpriced calls do not count** towards limits; a limit whose scope has unpriced calls this
  month says so next to its spend. Paperclip blocks instead (`unpriced_usage_policy=block`); in
  Orlok that would stop every colleague the first time an administrator chooses a new model, and
  a company may run on included models. The gap is made visible instead of blocking.
- The playground is metered but never blocked: it is how an administrator tests a provider.
- Raising or removing a limit applies at the next call; nothing has to be resumed.

*Admin → Costs* shows the month chosen: total, by office, by person, by model and by purpose,
priced and unpriced apart. **Not by colleague**: colleagues are private to their owner,
administrators included (R-ADM-3).

### W1.3 Interrupted commands have an unknown outcome

Today a restart marks running jobs `failed` with error `interrupted`, and the result is never
given back. The runner is a separate container: the command may have finished, or be still
running there.
- The colleague is told explicitly: *interrupted by a restart of Orlok while it was running; it
  may have run in full, in part or not at all: check the state on the target before running it
  again, and never repeat it blindly.*
- The person it was run for is notified like any late result, and the colleague reports it in a
  follow-up message, as for an approval decided late (R-OPS-5). A plan with an interrupted step
  stops there (unchanged behaviour), and says why.

### W1.4 Audit export (R-SEC-5, first half)

*Admin → Operations* exports the audit log — installation and every office — as CSV or JSON Lines,
with an optional date range. Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are
prefixed with `'` so a spreadsheet shows them instead of evaluating them (Paperclip
`routes/activity.ts`). Details never contain secrets (R-SEC-1), so the export does not either. The
export itself is written to the installation log. Retention stays open (wave 2).

## 2b. Chosen by the user on 2026-10-12, after the analyses of runner, approvals, memory, channels

### W1.5 Approvals bound to what runs (approvals analysis, proposal P1)

Found in the code: between "approve" and "run" nothing is checked again. A job asked in *ask*
mode still runs after its colleague's profile became *deny*; an MCP tool removed from the
server's allowed list still runs; requests never expire, so the window has no end. The approval
strip shows a plan's summary written by the model, not its commands, and an MCP call as its
arguments cut at 2,000 characters while the full input runs.
- No argument hash, unlike Paperclip: there the agent sends the arguments again when it retries,
  so the approval must be bound to them; in Orlok the job row is what runs and cannot change
  after it is requested, so a decision always applies to what the card shows. What was missing
  was showing all of it.
- Just before running, the job is judged again with the current profile mode, the person's
  current types and, for MCP, the current tool list and policy. If it would now need more than
  what was approved (deny mode, tool removed, type turned off by an administrator), it does not
  run: `failed` with `approval_stale`, reported like any late result.
- Changing or revoking a colleague's profile cancels its waiting requests.
- The strip shows the commands of a plan's steps and the full arguments of an MCP call, and the
  plan's card in the conversation approves or denies each step on its own, which R-OPS-6 asked
  for and the interface did not offer.
- Rejected for now: the IT duty colleague (P2), procedures promoted from approved work (P3),
  narrower "always" and request staleness (P4, P6); MCP tool governance stays wave 2 item 3.

### W1.6 Runner: tools, Windows, extension (runner analysis)

Paperclip runs the whole agent inside its sandbox; Orlok keeps the model and the credentials in
the server and sends the runner one command at a time. For IT operations this is the safer
shape, so the runner stays as it is, with every check outside it.
- **More tools in the standard image** (chosen): openssl, whois, rsync, tcpdump, net-snmp
  tools, ipmitool, redis-cli, ldap tools (ldapsearch), smbclient.
- **Windows** (chosen): PowerShell (`pwsh`) and `pypsrp` in the image, and WinRM as a second way
  to reach a host besides SSH (R-OPS-2), for Windows servers without OpenSSH.
- **Extension** (chosen): a documented derived image (`FROM orlok-runner`); the runner reports
  the tools it actually has, its standard ones and those a derived image declares, and colleagues
  are told which tools the runner offers. No installation at run time.
- **More runners** (chosen): registered with address and token, called by the server as today;
  runners that call the server from behind NAT are not planned.

### W1.7 Wiki (memory analysis)

Orlok's wiki is ahead of Paperclip's wiki almost everywhere (search, concurrency, loss
guard, lint, outdated knowledge, isolation). Chosen gaps:
1. **Secrets out of uploaded documents** before any model reads them, with one detector shared
   by import, filing and the write check, extended to `NAME_PASSWORD=` assignments, connection
   strings with a password and JWTs; how many were removed is shown on the document.
2. **Nightly lint**: the structural checks run every night for every office, not only after a
   document is filed, since most edits come from conversations.
3. **Retrieval that follows the conversation** (the previous message counts when the last one is
   short, "e su bak06?") and that gives the colleague the passage that matched instead of the
   first 6,000 characters of a long page.
4. **Provenance**: every revision records the conversation, message or document and the commands
   it came from; the history of a page shows it.
5. **Proposals for members**: a colleague working for someone who cannot edit the wiki proposes
   changes; office managers and administrators apply or reject them from the review queue.
6. **Private notes per colleague** (R-MEM-2): preferences and working context of one person
   with one colleague, never shown to anyone else, never in the office wiki.

### W1.8 Telegram (channels analysis)

One bot for the installation, which dispatches to the person's own colleagues: colleagues are
private, so Paperclip's bot per agent does not fit. Long polling (`getUpdates`), so nothing is
exposed. A person links their Telegram account from *Account* with a one-time link valid 15
minutes; messages from unlinked accounts and groups are ignored.
- **Notifications and approvals**: approvals waiting and late results arrive on Telegram; buttons
  approve once, always (the command types, for that person only, as in the app; asked by the user
  after the first version offered once and deny only) or deny. MCP tools and what is approved
  once each time link to the web app, and every click is checked again against the person the
  request is for.
- **Conversations**: talking to one's colleagues from Telegram, in the same conversations as the
  web (R-CHAT-12); `/colleague` chooses, `/new` starts a new conversation.

### W1.9 Remote machines and subscriptions (asked by the user later the same day)

- **Remote machines through a connector** (chosen): Paperclip has nothing for a machine that is
  not registered beforehand (its runner is started by the server for each run). Orlok gets a
  connector written in **Rust** (replacing the Go stub, at the user's request): from the web app
  an administrator creates a one-time token and an install command; the connector on the machine
  connects out over WebSocket (no open ports, works behind NAT), appears in *Admin → Hosts* to be
  approved, and only forwards connections to the machine's own SSH or WinRM (or to addresses of
  its LAN that are allowed). Commands still run from the runner with the person's credential,
  approvals and audit as today, so a compromised connector can open a port at most. This
  reverses "runners will not connect from behind NAT" for this one case: the runner stays
  called by the server. Executing commands in the connector itself, and a personal-PC mode with
  consent (R-OPS-9), were not chosen.
  **Paused by the user on 2026-10-12** before implementation started: nothing of it is built yet.
- **Subscriptions instead of Meridian** (not chosen): Paperclip uses Claude and ChatGPT
  subscriptions only by running Claude Code or the Codex CLI as the agent, never by calling the
  API with a subscription token. Anthropic reserves Pro/Max tokens to Claude Code and claude.ai,
  so either way risks the account; Meridian stays, and API keys remain the clean way.

## 3. Wave 2 — specified, not built yet

Ordered by value.

1. **Follow-ups and routines (R-OPS-12).** A colleague may schedule a one-shot check ("in 15
   minutes see whether the service came back") with a `followup_set` tool; it fires once into the
   same conversation and must be set again to wait longer. Routines are the recurring version,
   owned by one person and run with their credentials and profile: cron + timezone, concurrency
   *skip if still running*, missed runs skipped (Paperclip `skip_missed`, catch-up cap 25), each
   run a conversation of the owner, claimed with compare-and-set on `next_run_at`. Webhook
   triggers later, HMAC-signed with a replay window. Paperclip's lesson: every "later" is a row,
   never an in-memory timer, and a run that makes no progress backs off (2 → 30 minutes) instead
   of looping.
2. **Model fallback (R-MOD-3).** An ordered fallback profile on a profile, used on 429/5xx/quota
   errors only, never on budget; each turn records requested and actual model (Paperclip's
   attribution bug came from storing only the requested one). The fallback profile must have the
   same mode, so a fallback can never widen what a colleague may do.
3. **MCP tool changes reviewed.** On refresh, a tool whose schema changed, or a new tool on a
   server with an explicit tool list, is not given to colleagues until an administrator looks at
   it; a tool that turns from read-only to writing loses automatic execution. (Paperclip
   quarantines by schema hash.)
4. **Verified procedures (R-MEM-8) with test inputs.** From Skill Studio: a procedure page has
   versions, saved test inputs with expected notes, and test runs that freeze version, input and
   colleague settings; restoring creates a new version. A successful intervention proposes a
   draft to the review queue.
5. **Office and colleague packages (R-ADM-5/6, R-PRD-4).** Markdown packages (`OFFICE.md`,
   `COLLEAGUE.md` with frontmatter), slugs as identity, secrets omitted, collisions renamed or
   skipped, a report of what was not carried. Cloning is export + import in the same installation.
6. **Audit retention.** Per installation, default keep forever; purging writes a tombstone event
   with range, count and hash.
7. **Health and backups.** `/api/health` for administrators reports database, pgvector, runner,
   migrations and the age of the last backup marker; the server refuses to start on an
   unmigrated schema instead of half-working. A migration test refuses non-concurrent indexes on
   large tables and updates without `WHERE`.
8. **Channels (R-CHAT-9..11).** When built, take Paperclip's shapes: one endpoint per colleague,
   external accounts linked to people with a hashed one-time token, a session generation counter
   so one Telegram chat can start fresh conversations, late replies of cancelled turns discarded.
9. **Handoff (R-CHAT-8).** As a new conversation for the other person, seeded with a frozen
   summary and a link back, accepted by them before their colleague acts (it acts with *their*
   credentials); one hop only.

## 4. Rejected

- Heartbeats, org charts, CEO agents, goal hierarchies: Orlok's colleagues answer a person, they
  do not run a company.
- Driving external agent CLIs (Claude Code, Codex) by parsing their output: Paperclip's most
  fragile area (repeated model audits, patched SDKs). Orlok keeps calling provider APIs itself.
- A plugin system with worker processes: MCP servers already are Orlok's extension point.
- Liveness classification of model prose, automatic "productivity reviews": Paperclip removed or
  is removing them as noise.
- Budget reservations and invoice reconciliation: needed for uninterruptible external runs and
  subscription billing, not for calls Orlok makes and meters itself.
- Plan approval bound to a revision: Orlok's plans cannot be edited after they are proposed, so
  an approval cannot apply to a different plan.
