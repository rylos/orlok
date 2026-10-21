# Orlok runner

Internal service that runs commands for virtual colleagues (R-OPS-7): locally in its own
container (network and CLI tools) or on office hosts over SSH or, for Windows, WinRM, plus a stdio bridge for MCP servers
that must run as local processes (R-OPS-10). It ships as a separate container in the Orlok
compose project, has no access to the database or to Orlok's secrets at rest, and only receives
the credentials of a single job. Whether a command may run is decided by the Orlok server; the
runner only makes sure a hostile command cannot harm the runner or other jobs.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORLOK_RUNNER_TOKEN` | required (≥ 16 chars) | Bearer token the server sends. With `NODE_ENV=development` (`pnpm dev`) it defaults to `orlok-dev-runner-token`. |
| `PORT` / `HOST` | `3100` / `0.0.0.0` | Listen address. |
| `ORLOK_RUNNER_MAX_JOBS` | `8` | Concurrent jobs; more wait in a FIFO queue. |
| `ORLOK_RUNNER_MAX_MCP_SESSIONS` | `16` | Concurrent MCP server processes. |
| `ORLOK_RUNNER_SANDBOX_UID_BASE` | unset (image: `20000`) | Runs every local job and MCP server as its own uid (`base + slot`). Unset = same uid as the runner (development only). |
| `ORLOK_RUNNER_SANDBOX_LAUNCHER` | `/usr/local/libexec/orlok-setpriv` | setpriv copy with `cap_setuid,cap_setgid` file capabilities. |
| `ORLOK_RUNNER_LIMIT_MEMORY_MB` | `4096` | `RLIMIT_AS` (address space). |
| `ORLOK_RUNNER_LIMIT_CPU_SECONDS` | `900` | `RLIMIT_CPU`, local jobs only. |
| `ORLOK_RUNNER_LIMIT_FILE_MB` | `1024` | `RLIMIT_FSIZE`. |
| `ORLOK_RUNNER_LIMIT_OPEN_FILES` | `1024` | `RLIMIT_NOFILE`. |
| `ORLOK_RUNNER_LIMIT_PROCESSES` | `256` | `RLIMIT_NPROC`, only with sandbox uids (the limit is per uid). |
| `ORLOK_RUNNER_TMPDIR` | OS temp dir | Where job directories and SSH material live. |

Limits are applied with `prlimit` (soft = hard) when available, otherwise with `ulimit`; `0`
disables a limit.

## API

All routes except health need `Authorization: Bearer <token>` (401 otherwise). Types are in
`packages/shared/src/ops.ts`; errors are `{ code, message, issues? }`.

- `GET /v1/health` → `RunnerHealth` (`tools` = expected binaries found on `PATH`).
- `POST /v1/jobs` (`RunnerJobRequest`) → `202 { id }`, `409` duplicate id, `400` invalid body.
- `GET /v1/jobs/:id` → `RunnerJobState`, `404` unknown.
- `GET /v1/jobs/:id/stream` → SSE, one `RunnerStreamEvent` per `data:` line: the output so far,
  live output, then `end`; the stream closes after `end`.
- `POST /v1/jobs/:id/stop` → SIGTERM to the process tree, SIGKILL after 5 s; answers once the job
  has finished (status `stopped`).
- `POST /v1/mcp/sessions` (`{ id, command, args, env }`) → `201 { id }`, `409` duplicate,
  `429` session limit.
- `POST /v1/mcp/sessions/:id/messages` (one JSON-RPC object) → `202`, `404` unknown,
  `409` process exited.
- `GET /v1/mcp/sessions/:id/events` → SSE: stdout JSON lines as `data:`, stderr and non-JSON
  stdout lines as `event: log`, `event: exit` with `{ code, signal }`. Events produced while no
  client listens are buffered and replayed to the next one.
- `DELETE /v1/mcp/sessions/:id` → `204`. Sessions without messages for 30 minutes are killed.

Job semantics:

- `status`: `done` when the command ran to the end (any exit code), `failed` when it could not
  run (`error`: `spawn_failed`, `unreachable`, `auth_failed`, `host_key_mismatch`), `timeout`,
  `stopped`. A process killed by a signal reports `128 + signal` as exit code.
- Jobs waiting in the queue are reported as `running` with empty output; `startedAt` is the time
  the job was accepted. The timeout counts from process start and is capped at 3600 s;
  `maxOutputBytes` is capped at 16 MiB.
- Output: stdout and stderr in arrival order, UTF-8 (invalid bytes replaced), ANSI sequences
  removed, secrets and their base64 forms replaced with `[secret removed]` (also each long line of
  multi-line secrets such as private keys). Over `maxOutputBytes` the first 80% and the last 20%
  are kept around `[… output truncated …]`; the live stream stops at the marker and the `end`
  state carries the tail.
- Finished jobs are kept for one hour.
- SSH: `hostKey` is the verified key, or the key fetched with `ssh-keyscan` when `knownHostKey`
  was null (store it and send it as `knownHostKey` next time). On `host_key_mismatch` it is null
  and the command never ran.

## Security model

- Local jobs and MCP servers run through `setpriv` as a dedicated uid per job (`20000 + slot`)
  with `no_new_privs`, no supplementary groups, no capabilities and the resource limits above, in a
  fresh `0700` directory (also `HOME` and `TMPDIR`) with a minimal environment (`PATH`, `HOME`,
  `TMPDIR`, `LANG=C.UTF-8`, `TERM=dumb`; MCP sessions add their `env`). stdin is closed for jobs.
  Separate uids mean a job cannot read another job's files or environment, signal it, or read the
  runner's own process (token, SSH material). When a job ends every process of its uid is killed
  (including ones that left the process group) and its directory is removed.
- SSH runs as the runner user with the OpenSSH client only: `-F /dev/null`, strict host key
  checking against a per-job known_hosts file, `IdentitiesOnly`, no agent or forwarding, the
  remote command after `--`. Keys (0600), known_hosts and the askpass helper live in a per-job
  directory under a 0700 runner-only directory and are deleted when the job ends; the whole tree
  is removed on shutdown. Passwords reach `sshpass -e` through its environment only; passphrases
  reach the askpass helper through its environment only.
- The token is compared in constant time and removed from the runner's environment at start.
- Residual risks: masking is best effort (a hostile command can always re-encode a secret it can
  read, so the server must pass only the job's own credentials); command lines are visible to
  other processes in `/proc`, so secrets must never be embedded in commands; without
  `ORLOK_RUNNER_SANDBOX_UID_BASE` all jobs share the runner uid (development only).
- PowerShell targets receive `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`;
  very long commands can exceed the Windows command line limit (~32 000 characters, about
  12 000 characters of script).

## Docker

```sh
docker build -f apps/runner/Dockerfile -t orlok-runner .
```

`apps/runner/Dockerfile.dockerignore` keeps the context small with BuildKit (buildx); the root
`.dockerignore` does the same for the legacy builder.

The image runs as `runner` (uid 10001) under tini and includes openssh-client, sshpass, iputils,
bind-tools, curl, wget, nmap, mtr, netcat-openbsd, jq, postgresql-client, mariadb-client,
sqlcmd (go-sqlcmd, a static binary without the ODBC driver, downloaded and checksum-verified at
build time), openssl, whois, rsync, tcpdump, net-snmp tools (snmpwalk…), ipmitool, valkey-cli
(Redis-compatible), openldap clients (ldapsearch), smbclient, PowerShell 7 (`pwsh`, x86_64 only:
Microsoft builds it for musl on that architecture alone; checksum-verified), python3, uv/uvx,
git, npm/npx, util-linux (prlimit, setpriv), ca-certificates and tzdata. `pypsrp` lives in its
own environment (`/opt/orlok-winrm`), used only by the WinRM helper.

### WinRM

Windows hosts without OpenSSH are reached over WinRM (R-OPS-2) by
`/usr/local/libexec/orlok_winrm.py` (source in `apps/runner/winrm/`), run as the runner user
like `ssh`. The password reaches it through its environment, the script through a file of the
job's private directory, and the outcome (exit code, error) comes back as JSON in another one;
nothing goes on the command line. Over http (port 5985) sign-in and commands are encrypted by
NTLM or Kerberos message encryption; over https (5986) the certificate is verified against the
system CAs. Output arrives line by line; errors are written as `ERROR: message` in order with
the output, and a command that wrote an error and set no exit code ends with 1. Failures:
`auth_failed`, `unreachable`, `certificate_invalid`, `winrm_error`. Only password credentials
open WinRM.

### Adding tools: derived images

The runner's root filesystem is read-only and nothing is installed at run time: what is not in
the image does not exist, so every job sees the same tools. To add a vendor CLI, build an image
on top of the standard one and declare the tools it adds, one name per line, in a file under
`/etc/orlok-runner/tools.d/` (or in `ORLOK_RUNNER_EXTRA_TOOLS`, separated by commas):

```dockerfile
FROM orlok-runner:<version>
USER root
RUN apk add --no-cache aws-cli \
  && mkdir -p /etc/orlok-runner/tools.d \
  && printf 'aws\n' > /etc/orlok-runner/tools.d/aws.list
USER runner
```

Then set `ORLOK_RUNNER_IMAGE` to the new image in `.env` and `docker compose up -d`. The runner
reports in `/v1/health` the standard tools and the declared ones it actually finds on `PATH`, and
colleagues are told that list when they look at where they can run commands. Rebuild the derived
image on every Orlok upgrade.
Sandboxed jobs run with `no_new_privs`, so `ping` uses unprivileged ICMP sockets
(`net.ipv4.ping_group_range`, which Docker sets by default); `NET_RAW` is only needed if you drop
all capabilities and want raw sockets elsewhere. `uvx`/`npx` download packages into the session
directory each time; bake frequently used MCP servers into a derived image
(`uv tool install ...`) to avoid that.

```yaml
services:
  runner:
    image: orlok-runner
    environment:
      ORLOK_RUNNER_TOKEN: ${ORLOK_RUNNER_TOKEN}
    # No ports: only the Orlok server reaches it on the internal network. No database
    # network, no volumes with Orlok data.
    networks: [runner]
    read_only: true
    tmpfs:
      # exec is required: uvx environments and the SSH askpass helper run from here.
      - /tmp:exec,mode=1777,size=1g
    cap_drop: [ALL]
    # SETUID/SETGID: the sandbox launcher switches jobs to their own uid. NET_RAW: raw ICMP.
    cap_add: [SETUID, SETGID, NET_RAW]
    # Do not set security_opt no-new-privileges: it disables the launcher's file capabilities.
    pids_limit: 2048
    init: false
    restart: unless-stopped
```

The server needs `ORLOK_RUNNER_URL` (e.g. `http://runner:3100`) and the same token.

## Development

```sh
pnpm --filter @orlok/runner dev    # tsx watch, token orlok-dev-runner-token, no uid sandbox
pnpm --filter @orlok/runner test   # SSH tests start a private sshd when /usr/bin/sshd exists
```
