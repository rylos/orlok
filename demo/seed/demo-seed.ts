import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { MessagePart, ModelRates, WikiEdit, WikiPageStatus } from "@orlok/shared";
import { count, eq } from "drizzle-orm";
import { hashPassword } from "../../apps/server/src/auth/password";
import { createDatabase, runMigrations } from "../../apps/server/src/db/client";
import {
  budgets,
  colleagues,
  conversations,
  messages,
  modelPrices,
  modelProfiles,
  modelProviders,
  modelUsage,
  officeMembers,
  offices,
  opsJobs,
  opsPlans,
  profileGrants,
  settings,
  users,
  wikiReviewItems,
} from "../../apps/server/src/db/schema";
import { encryptSecret } from "../../apps/server/src/lib/crypto";
import { approveTypes } from "../../apps/server/src/ops/approved-types";
import { createHost } from "../../apps/server/src/ops/hosts";
import { type JobTarget, requestJob } from "../../apps/server/src/ops/jobs";
import { type PlanStepInput, requestPlan } from "../../apps/server/src/ops/plans";
import { createCredential } from "../../apps/server/src/ops/vault";
import { costMicros } from "../../apps/server/src/services/costs";
import { COMPANY_NAME_KEY, DEFAULT_LOCALE_KEY } from "../../apps/server/src/services/installation";
import { findPageRow, insertPage, savePageRevision } from "../../apps/server/src/services/wiki";
import { MIGRATIONS_FOLDER } from "../../apps/server/src/test/db";

// pnpm --filter @orlok/demo-seed seed --database <url> --secret-key <base64> (or demo/setup.sh)
// Fills an EMPTY database with a fictional company, for screenshots of the product (orlok.xyz):
// Acme, its people, colleagues, hosts, wiki, conversations with commands and a month of model
// usage. Every name, address and output is made up (192.0.2.0/24, example.com). It refuses a
// database that already has people, and it never runs by itself: point it at a throwaway database,
// never at a real installation. --secret-key must be the ORLOK_SECRET_KEY of the app that will
// show the data.

const { values } = parseArgs({
  options: {
    database: { type: "string", default: process.env.DATABASE_URL },
    "secret-key": { type: "string", default: process.env.ORLOK_SECRET_KEY },
    password: { type: "string", default: "demo-password-acme" },
    // Where to write the app paths of the screens worth showing, for the screenshot script.
    paths: { type: "string" },
  },
});

if (!values.database || !values["secret-key"]) {
  console.error(
    "Usage: pnpm --filter @orlok/demo-seed seed --database <url> --secret-key <base64> [--password <text>]",
  );
  process.exit(2);
}
const secretKey = Buffer.from(values["secret-key"], "base64");
if (secretKey.length !== 32) {
  console.error("--secret-key must be a base64-encoded 32-byte key");
  process.exit(2);
}

const { db, close } = createDatabase(values.database);
await runMigrations(db, MIGRATIONS_FOLDER);
const [people] = await db.select({ total: count() }).from(users);
if ((people?.total ?? 0) > 0) {
  console.error("The database already has people: the demo seed only fills an empty one.");
  await close();
  process.exit(1);
}

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

// --- Company, people, models ---------------------------------------------------------------

for (const [key, value] of [
  [COMPANY_NAME_KEY, "Acme"],
  [DEFAULT_LOCALE_KEY, "en"],
  // The nightly wiki check (LINT_DAY_KEY in services/wiki-review.ts) counts as done today: a
  // minute after the app starts it would close the review items below, which use documentation
  // addresses (192.0.2.0/24) the check leaves out.
  ["wiki_lint_last_day", new Date(now).toISOString().slice(0, 10)],
] as const) {
  await db.insert(settings).values({ key, value });
}

const passwordHash = await hashPassword(values.password);
const [alexRow, samRow] = await db
  .insert(users)
  .values([
    {
      email: "alex.morgan@acme.example",
      displayName: "Alex Morgan",
      passwordHash,
      role: "admin",
      locale: "en",
    },
    {
      email: "sam.rivera@acme.example",
      displayName: "Sam Rivera",
      passwordHash,
      role: "member",
      locale: "en",
    },
  ])
  .returning();
if (!alexRow || !samRow) throw new Error("People insert returned no rows");
const alex = alexRow;
const sam = samRow;

const [cloud, local, budget] = await db
  .insert(modelProviders)
  .values([
    {
      name: "Cloud provider",
      kind: "anthropic",
      apiKeyEncrypted: encryptSecret("not-a-real-key", secretKey),
      billing: "per_token",
    },
    {
      name: "Local models",
      kind: "ollama",
      baseUrl: "http://models.acme.example:11434",
      billing: "included",
    },
    {
      name: "Second provider",
      kind: "openai_compatible",
      baseUrl: "https://api.provider-two.example",
      apiKeyEncrypted: encryptSecret("not-a-real-key", secretKey),
      billing: "per_token",
    },
  ])
  .returning();
if (!cloud || !local || !budget) throw new Error("Provider insert returned no rows");

const LARGE = "large-v5";
const SMALL = "small-v5";
const LOCAL = "local-32b";
// Generic names, so the site shows no model or provider brand; made-up prices.
const BUDGET = "budget-v4";
const RATES: Record<string, ModelRates> = {
  [LARGE]: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  [SMALL]: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  [BUDGET]: { input: 1.32, cachedInput: 0.044, cacheWrite: null, output: 3.96 },
};
await db.insert(modelPrices).values(
  Object.entries(RATES).map(([model, rates]) => ({
    providerId: model === BUDGET ? budget.id : cloud.id,
    model,
    rates,
  })),
);

const profileRows = await db
  .insert(modelProfiles)
  .values([
    {
      name: "Large · Ask",
      providerId: cloud.id,
      model: LARGE,
      mode: "ask",
      contextWindow: 200_000,
    },
    {
      name: "Large · Full access",
      providerId: cloud.id,
      model: LARGE,
      mode: "full",
      contextWindow: 200_000,
    },
    {
      name: "Small · Ask",
      providerId: cloud.id,
      model: SMALL,
      mode: "ask",
      contextWindow: 200_000,
    },
    { name: "Local · No commands", providerId: local.id, model: LOCAL, mode: "deny" },
    {
      name: "XL · Ask",
      providerId: cloud.id,
      model: "xl-v5",
      mode: "ask",
      contextWindow: 1_000_000,
    },
    { name: "Budget · Ask", providerId: budget.id, model: BUDGET, mode: "ask" },
    { name: "Local · Ask", providerId: local.id, model: LOCAL, mode: "ask" },
    {
      name: "Large · Yolo (test lab)",
      providerId: cloud.id,
      model: LARGE,
      mode: "yolo",
      contextWindow: 200_000,
    },
  ])
  .returning();
const profile = (name: string) => {
  const row = profileRows.find((item) => item.name === name);
  if (!row) throw new Error(`Missing profile ${name}`);
  return row;
};
await db
  .insert(profileGrants)
  .values([
    ...profileRows.map((row) => ({ userId: alex.id, profileId: row.id })),
    { userId: sam.id, profileId: profile("Large · Ask").id },
    { userId: sam.id, profileId: profile("Local · No commands").id },
  ]);

const officeRows = await db
  .insert(offices)
  .values([
    {
      name: "IT",
      description: "Servers, network and workstations",
      wikiPurpose: "How Acme's servers and services are set up, and how to fix what breaks.",
    },
    { name: "Finance", description: "Invoices, payments and reports" },
  ])
  .returning();
const itRow = officeRows.find((row) => row.name === "IT");
const financeRow = officeRows.find((row) => row.name === "Finance");
if (!itRow || !financeRow) throw new Error("Office insert returned no rows");
const it = itRow;
const finance = financeRow;
await db.insert(officeMembers).values({ officeId: it.id, userId: sam.id, role: "member" });

const colleagueRows = await db
  .insert(colleagues)
  .values([
    {
      userId: alex.id,
      officeId: it.id,
      name: "Ada",
      title: "Systems administrator",
      profileId: profile("Large · Ask").id,
    },
    {
      userId: alex.id,
      officeId: it.id,
      name: "Linus",
      title: "Network engineer",
      profileId: profile("Budget · Ask").id,
    },
    {
      userId: alex.id,
      officeId: finance.id,
      name: "Iris",
      title: "Accounts assistant",
      profileId: profile("Local · No commands").id,
    },
    {
      userId: sam.id,
      officeId: it.id,
      name: "Grace",
      title: "Help desk",
      profileId: profile("Large · Ask").id,
    },
    // The office colleague (R-ADM-8): set up by Alex as an administrator, for everyone in IT.
    {
      userId: alex.id,
      officeId: it.id,
      name: "Guide",
      title: "IT help desk for everyone",
      instructions: "Answer in short steps. For anything about passwords, send people to Sam.",
      profileId: profile("Local · No commands").id,
      officeWide: true,
    },
  ])
  .returning();
const colleague = (name: string) => {
  const row = colleagueRows.find((item) => item.name === name);
  if (!row) throw new Error(`Missing colleague ${name}`);
  return row;
};
const ada = colleague("Ada");
const guide = colleague("Guide");

// --- Hosts and Alex's credentials ------------------------------------------------------------

const web01 = await createHost(
  db,
  {
    name: "web-01",
    kind: "linux",
    connection: "ssh",
    address: "192.0.2.10",
    port: 22,
    tags: ["web", "production"],
    description: "Public website, nginx",
    enabled: true,
  },
  alex.id,
);
const db01 = await createHost(
  db,
  {
    name: "db-01",
    kind: "linux",
    connection: "ssh",
    address: "192.0.2.30",
    port: 22,
    tags: ["database"],
    description: "PostgreSQL for the intranet",
    enabled: true,
  },
  alex.id,
);
const app01 = await createHost(
  db,
  {
    name: "app-01",
    kind: "windows",
    connection: "winrm",
    address: "192.0.2.20",
    port: 5985,
    tags: ["windows", "printing"],
    description: "Line-of-business app and print server",
    enabled: true,
  },
  alex.id,
);
const app02 = await createHost(
  db,
  {
    name: "app-02",
    kind: "windows",
    connection: "winrm",
    address: "192.0.2.21",
    port: 5985,
    tags: ["windows", "printing"],
    description: "Print server of the branch office",
    enabled: true,
  },
  alex.id,
);
await createCredential(
  db,
  alex.id,
  {
    name: "Alex on the Linux servers",
    kind: "ssh_key",
    username: "alex",
    description: null,
    secret: "not-a-real-key",
    passphrase: null,
    hostIds: [web01.id, db01.id],
  },
  secretKey,
);
const dc01 = await createHost(
  db,
  {
    name: "dc-01",
    kind: "windows",
    connection: "winrm",
    address: "192.0.2.40",
    port: 5985,
    tags: ["windows", "active-directory"],
    description: "Domain controller of acme.example",
    enabled: true,
  },
  alex.id,
);
await createCredential(
  db,
  alex.id,
  {
    name: "Alex on the Windows servers",
    kind: "password",
    username: "ACME\\alex",
    description: null,
    secret: "not-a-real-password",
    passphrase: null,
    hostIds: [app01.id, app02.id, dc01.id],
  },
  secretKey,
);
await approveTypes(db, { userId: alex.id, shell: "posix", types: ["systemctl restart"] });
await approveTypes(db, { userId: alex.id, shell: "posix", types: ["docker compose restart"] });
await approveTypes(db, { userId: alex.id, shell: "posix", types: ["certbot renew"] });
await approveTypes(db, { userId: alex.id, shell: "powershell", types: ["Clear-DnsClientCache"] });

const hostRow = async (id: string) => {
  const { hosts } = await import("../../apps/server/src/db/schema");
  const [row] = await db.select().from(hosts).where(eq(hosts.id, id));
  if (!row) throw new Error("Missing host");
  return row;
};
const onWeb01: JobTarget = { kind: "host", host: await hostRow(web01.id) };
const onApp01: JobTarget = { kind: "host", host: await hostRow(app01.id) };
const onApp02: JobTarget = { kind: "host", host: await hostRow(app02.id) };
const onDb01: JobTarget = { kind: "host", host: await hostRow(db01.id) };
const onDc01: JobTarget = { kind: "host", host: await hostRow(dc01.id) };

// --- Wiki ------------------------------------------------------------------------------------

const asAlex = { userId: alex.id };
const asAda = { colleagueId: ada.id };
const PAGES: {
  slug: string;
  title: string;
  section: string | null;
  type: "overview" | "entity" | "concept" | "procedure" | "note";
  status?: WikiPageStatus;
  content: string;
}[] = [
  {
    slug: "it-overview",
    title: "IT at Acme",
    section: null,
    type: "overview",
    content:
      "Acme runs a small set of servers in its own rack and a few cloud services.\n\n## Servers\n\n- [[web-01]]: public website\n- [[db-01]]: intranet database\n- [[app-01]]: business app and printing\n\n## How we work\n\n- Changes go through a colleague in *ask* mode, so someone approves what runs.\n- Procedures: [[disk-space-web-01]], [[print-spooler]], [[nginx-config-changes]], [[connect-to-vpn]].",
  },
  {
    slug: "web-01",
    title: "web-01",
    section: "Servers",
    type: "entity",
    content:
      "Ubuntu 24.04, nginx, serves www.example.com.\n\n| | |\n|---|---|\n| Address | 192.0.2.10 |\n| Disk | 80 GB, logs under /var/log |\n| Owner | IT |\n\nSee [[disk-space-web-01]] when the disk fills up and [[nginx-config-changes]] before editing the config.",
  },
  {
    slug: "db-01",
    title: "db-01",
    section: "Servers",
    type: "entity",
    content:
      "Debian 13, PostgreSQL 18 for the [[intranet-app]]. Nightly dump at 02:00, kept 14 days.\n\nLinked from [[it-overview]].",
  },
  {
    slug: "app-01",
    title: "app-01",
    section: "Servers",
    type: "entity",
    content:
      "Windows Server 2025: the [[accounting-app]] and the office print queues ([[printer-fleet]]).\n\nThe print spooler sometimes stops after a driver update: see [[print-spooler]].",
  },
  {
    slug: "disk-space-web-01",
    title: "Disk space on web-01",
    section: "Procedures",
    type: "procedure",
    content:
      "When [[web-01]] goes above 90%:\n\n1. `df -h` to see which filesystem is full.\n2. `du -sh /var/log/*` to find the largest logs.\n3. Shrink the journal: `journalctl --vacuum-size=500M`.\n4. Check again with `df -h`.\n\nNever delete files under /var/www by hand.",
  },
  {
    slug: "connect-to-vpn",
    title: "Connect to the VPN",
    section: "Procedures",
    type: "procedure",
    content:
      "From home or on the road, the intranet and the shared folders need the VPN.\n\n1. Install the WireGuard app from the company portal (laptops from IT already have it).\n2. Open https://vpn.acme.example, sign in with your Acme account and download your profile.\n3. In WireGuard, choose *Import tunnel from file* and pick the downloaded file.\n4. Turn the *Acme* tunnel on.\n5. Check: https://intranet.example.com opens, and the server network 192.0.2.0/24 ([[office-network]]) answers.\n\nA profile lasts 90 days; when it expires, download a new one from step 2. If the portal refuses your account, ask IT.",
  },
  {
    slug: "print-spooler",
    title: "Print spooler on app-01",
    section: "Procedures",
    type: "procedure",
    content:
      "Symptoms: jobs stuck in the queue, users see *printer offline*.\n\n1. `Get-Service Spooler` on [[app-01]].\n2. If it is stopped: `Restart-Service Spooler`.\n3. Ask the user to print a test page.",
  },
  {
    slug: "nginx-config-changes",
    title: "Changing the nginx configuration",
    section: "Procedures",
    type: "concept",
    content:
      "Every change to nginx on [[web-01]] is tested before it is loaded:\n\n1. `nginx -t` checks the syntax.\n2. `sudo systemctl reload nginx` loads it without dropping connections.\n3. `curl -sI https://www.example.com` checks the site answers.\n\nCertificates are in [[tls-certificates]].",
  },
  {
    slug: "app-02",
    title: "app-02",
    section: "Servers",
    type: "entity",
    content:
      "Windows Server 2025 at the branch office, address 192.0.2.21: the branch print queues ([[printer-fleet]]).\n\nSame spooler procedure as [[app-01]]: [[print-spooler]].",
  },
  {
    slug: "database-backups",
    title: "Database backups",
    section: "Procedures",
    type: "procedure",
    content:
      "The intranet database on [[db-01]] is dumped every night at 01:30 and copied to the NAS.\n\n> **Superseded (2026-09-15):** dumps kept 14 days → 30 days, after the September audit.\n\nCheck the last dumps with `du -sh /var/backups/postgresql/*`. Test a restore every quarter: [[restore-test]].",
  },
  {
    slug: "restore-test",
    title: "Quarterly restore test",
    section: "Procedures",
    type: "procedure",
    content:
      "Every quarter, restore the last dump of [[db-01]] on a test machine and open the [[intranet-app]] on it.\n\nWrite the date and the time it took in [[database-backups]].",
  },
  {
    slug: "intranet-app",
    title: "Intranet",
    section: "Applications",
    type: "entity",
    content:
      "intranet.example.com: news, room booking and forms. Data on [[db-01]], served by nginx on [[web-01]].",
  },
  {
    slug: "accounting-app",
    title: "Accounting application",
    section: "Applications",
    type: "entity",
    content:
      "Runs on [[app-01]]. Its data is exported every night with the [[database-backups]], so a restore covers it too.",
  },
  {
    slug: "printer-fleet",
    title: "Printers",
    section: "Printing",
    type: "entity",
    content:
      "Six printers in the office on [[app-01]], two at the branch on [[app-02]]. When nothing prints, see [[print-spooler]].",
  },
  {
    slug: "tls-certificates",
    title: "TLS certificates",
    section: "Network",
    type: "concept",
    content:
      "www.example.com and intranet.example.com use certificates renewed automatically on [[web-01]]. DNS names are in [[dns-records]].",
  },
  {
    slug: "office-network",
    title: "Office network",
    section: "Network",
    type: "concept",
    content:
      "One network for servers, 192.0.2.0/24: [[web-01]] .10, [[app-01]] .20, [[app-02]] .22, [[db-01]] .30.\n\nRules in [[firewall-rules]], names in [[dns-records]].",
  },
  {
    slug: "firewall-rules",
    title: "Firewall rules",
    section: "Network",
    type: "concept",
    content:
      "Only ports 80 and 443 of [[web-01]] are open to the internet. Everything else stays inside the [[office-network]].",
  },
  {
    slug: "dns-records",
    title: "DNS records",
    section: "Network",
    type: "concept",
    content:
      "www and intranet point to [[web-01]]. Internal names are served on the [[office-network]]; certificates depend on them ([[tls-certificates]]).",
  },
  {
    slug: "monitoring",
    title: "Monitoring",
    section: null,
    type: "concept",
    content:
      "Alerts go to the IT mailbox: disk above 90% on [[web-01]], a failed dump in [[database-backups]], the spooler stopped on [[app-01]], a link down on the [[office-network]].",
  },
  {
    slug: "fax-line",
    title: "Fax line",
    section: null,
    type: "note",
    status: "historical",
    content: "The office fax was switched off in March 2025; the number now forwards to reception.",
  },
  {
    slug: "meeting-room-screens",
    title: "Meeting room screens",
    section: null,
    type: "note",
    content:
      "The two screens connect with a USB-C cable on the table; the remote is in the drawer.",
  },
];
for (const page of PAGES) {
  await insertPage(
    db,
    it.id,
    page.slug,
    {
      title: page.title,
      section: page.section,
      type: page.type,
      content: page.content,
      sources: [],
      ...(page.status ? { status: page.status } : {}),
    },
    asAlex,
    "First version",
  );
}
// A second revision by the colleague, so the page has a history.
const diskPage = await findPageRow(db, it.id, "disk-space-web-01");
if (diskPage) {
  await savePageRevision(
    db,
    diskPage,
    {
      content: `${diskPage.content}\n\nLast done on ${minutesAgo(60 * 24 * 9)
        .toISOString()
        .slice(0, 10)}: the journal had grown to 6 GB.`,
    },
    asAda,
    "Added the last time it happened",
  );
}
const db01Page = await findPageRow(db, it.id, "db-01");
if (!db01Page) throw new Error("Missing page db-01");
const db01Revised = await savePageRevision(
  db,
  db01Page,
  { content: db01Page.content.replace("02:00", "01:30") },
  asAlex,
  "Nightly dump moved to 01:30",
);
if (!db01Revised) throw new Error("db-01 revision failed");
await db.insert(wikiReviewItems).values([
  {
    officeId: it.id,
    kind: "stale_page",
    key: "stale:db-01",
    title: "db-01 not checked for 6 months",
    detail: "The backup schedule may have changed since the page was written.",
    slugs: ["db-01"],
  },
  {
    officeId: it.id,
    kind: "ip_conflict",
    key: "ip:app-02",
    title: "app-02",
    detail: "192.0.2.21 in [[app-02]], 192.0.2.22 in [[office-network]].",
    slugs: ["app-02", "office-network"],
  },
  {
    officeId: it.id,
    kind: "missing_page",
    key: "missing:vpn",
    title: "No page about the office VPN",
    detail: "Three conversations this month asked how to connect from home.",
    suggestedSlug: "office-vpn",
  },
  {
    officeId: it.id,
    kind: "question",
    title: "Who renews the www.example.com certificate?",
    detail: "Ada could not find it in the wiki while checking [[web-01]].",
    slugs: ["web-01"],
    raisedByColleagueId: ada.id,
  },
]);

// --- Conversations with commands ---------------------------------------------------------------

type Step =
  | { text: string }
  | {
      command: string;
      reason: string;
      target: JobTarget;
      // Finished commands come with their output; the others wait for approval, or with hold
      // wait for the video script (shoot-video.mjs) to let them run.
      output?: string;
      hold?: boolean;
    };

async function conversation(
  title: string,
  startedMinutesAgo: number,
  turns: [string, Step[]][],
  extra: {
    wikiEdits?: WikiEdit[];
    // A plan waiting for approval at the end of the last answer.
    plan?: { title: string; summary: string; text: string; steps: PlanStepInput[] };
  } = {},
) {
  const [row] = await db
    .insert(conversations)
    .values({
      colleagueId: ada.id,
      userId: alex.id,
      title,
      createdAt: minutesAgo(startedMinutesAgo),
      updatedAt: minutesAgo(startedMinutesAgo - turns.length * 2),
    })
    .returning();
  if (!row) throw new Error("Conversation insert returned no row");
  let at = startedMinutesAgo;
  const held: string[] = [];
  for (const [turn, [question, steps]] of turns.entries()) {
    await db.insert(messages).values({
      conversationId: row.id,
      role: "user",
      content: question,
      createdAt: minutesAgo(at),
    });
    at -= 1;
    const parts: MessagePart[] = [];
    const jobIds: string[] = [];
    for (const step of steps) {
      if ("text" in step) {
        parts.push({ type: "text", text: step.text });
        continue;
      }
      const job = await requestJob(db, {
        officeId: it.id,
        colleagueId: ada.id,
        conversationId: row.id,
        userId: alex.id,
        target: step.target,
        command: step.command,
        reason: step.reason,
        timeoutSeconds: 60,
        policy: { mode: "ask" },
      });
      if (step.output !== undefined) {
        await db
          .update(opsJobs)
          .set({
            status: "done",
            exitCode: 0,
            output: step.output,
            reported: true,
            createdAt: minutesAgo(at),
            startedAt: minutesAgo(at),
            finishedAt: minutesAgo(at),
          })
          .where(eq(opsJobs.id, job.id));
      } else if (step.hold) {
        // Stopped until shoot-video.mjs queues it again, so it runs while the camera is on.
        await db
          .update(opsJobs)
          .set({ status: "stopped", createdAt: minutesAgo(at) })
          .where(eq(opsJobs.id, job.id));
        held.push(job.id);
      } else {
        await db
          .update(opsJobs)
          .set({ createdAt: minutesAgo(at) })
          .where(eq(opsJobs.id, job.id));
      }
      parts.push({ type: "job", jobId: job.id });
      jobIds.push(job.id);
    }
    if (extra.plan && turn === turns.length - 1) {
      const planned = await requestPlan(db, {
        officeId: it.id,
        colleagueId: ada.id,
        conversationId: row.id,
        userId: alex.id,
        title: extra.plan.title,
        summary: extra.plan.summary,
        steps: extra.plan.steps,
        policy: { mode: "ask" },
      });
      await db
        .update(opsPlans)
        .set({ createdAt: minutesAgo(at) })
        .where(eq(opsPlans.id, planned.plan.id));
      parts.push({ type: "text", text: extra.plan.text });
      for (const job of planned.jobs) {
        parts.push({ type: "job", jobId: job.id });
        jobIds.push(job.id);
      }
    }
    await db.insert(messages).values({
      conversationId: row.id,
      role: "assistant",
      content: [
        ...steps.flatMap((step) => ("text" in step ? [step.text] : [])),
        ...(extra.plan && turn === turns.length - 1 ? [extra.plan.text] : []),
      ].join("\n\n"),
      model: LARGE,
      inputTokens: 18_400,
      outputTokens: 640,
      opsJobIds: jobIds,
      parts,
      // The wiki pages the colleague changed, under its last answer.
      ...(extra.wikiEdits && turn === turns.length - 1 ? { wikiEdits: extra.wikiEdits } : {}),
      createdAt: minutesAgo(at),
    });
    at -= 1;
  }
  // The first request, for the screens where it is typed but not sent yet.
  return { ...row, held, prompt: turns[0]?.[0] ?? "" };
}

const disk = await conversation("web-01 disk almost full", 60 * 26, [
  [
    "The monitoring says web-01 is at 92% disk. Can you check what is taking the space?",
    [
      { text: "I'll look at the filesystems first." },
      {
        command: "df -h /",
        reason: "See how full the root filesystem is",
        target: onWeb01,
        output:
          "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        79G   73G  6.4G  92% /",
      },
      {
        command: "du -sh /var/log/* | sort -rh | head -5",
        reason: "Find the largest logs",
        target: onWeb01,
        output:
          "6.1G\t/var/log/journal\n1.2G\t/var/log/nginx\n310M\t/var/log/syslog.1\n96M\t/var/log/syslog\n12M\t/var/log/apt",
      },
      {
        text: "The systemd journal takes 6.1 GB. As in [[disk-space-web-01]], shrinking it to 500 MB frees about 5.6 GB without touching the website. I asked to run it: approve it when you are ready.",
      },
      {
        command: "journalctl --vacuum-size=500M",
        reason: "Shrink the journal to 500 MB, as the wiki procedure says",
        target: onWeb01,
      },
    ],
  ],
]);

const spooler = await conversation("Printing stopped in the office", 12, [
  [
    "Nobody can print since this morning. Can you check app-01?",
    [
      { text: "Printing goes through the spooler on app-01. Let me check it." },
      {
        command: "Get-Service Spooler | Select-Object Name, Status, StartType",
        reason: "Check whether the print spooler is running",
        target: onApp01,
        output: "Name    Status StartType\n----    ------ ---------\nSpooler Stopped Automatic",
      },
      {
        text: "The spooler is stopped although it should start automatically, which matches [[print-spooler]]. Restarting it should bring the queues back.",
      },
      {
        command: "Restart-Service Spooler",
        reason: "Restart the print spooler so the queues work again",
        target: onApp01,
      },
    ],
  ],
]);

// What the colleague proposes to keep once the disk conversation went quiet (R-MEM-16).
await db
  .update(conversations)
  .set({
    wikiCandidates: [
      {
        title: "The journal is what fills web-01",
        summary:
          "On web-01 the disk filled up because the systemd journal had grown to 6.1 GB; shrinking it to 500 MB freed 5.6 GB.",
        slug: "disk-space-web-01",
      },
      {
        title: "Cap the journal size on web-01",
        summary:
          "Setting SystemMaxUse=500M in journald.conf would stop the journal from growing again.",
        slug: null,
      },
    ],
  })
  .where(eq(conversations.id, disk.id));

// For the videos (shoot-video.mjs): a read command that runs while the camera is on, and the
// same kind of restart as in the office, on the branch server, once Alex always allows it.
const dbHealth = await conversation("Is the intranet database healthy?", 6, [
  [
    "Can you check that the intranet database on db-01 is fine and the backups are there?",
    [
      { text: "First whether PostgreSQL is running, then the size of the last dumps." },
      {
        command: "systemctl is-active postgresql",
        reason: "Check that PostgreSQL is running",
        target: onDb01,
        output: "active",
      },
      {
        command: "du -sh /var/backups/postgresql/*",
        reason: "See the size of the last nightly dumps",
        target: onDb01,
        hold: true,
      },
    ],
  ],
]);
const branch = await conversation("Printing stopped at the branch office", 3, [
  [
    "The branch office says their printers are offline too. Can you check app-02?",
    [
      { text: "Same symptoms as this morning in the office: I'll restart the spooler on app-02." },
      {
        command: "Restart-Service Spooler",
        reason: "Restart the print spooler so the branch queues work again",
        target: onApp02,
        hold: true,
      },
    ],
  ],
]);

// For the Active Directory video (shoot-video.mjs --only ad): a new person in Accounting gets a
// domain account with the groups of a colleague in the same job. Ada reads without asking, then
// plans the changes; the account is created disabled, because the first password is set by a
// person in Active Directory, never in a conversation. The summary and the wiki proposal come
// from the video script once the plan ran (adSummary, adCandidates below).
const OU = "OU=Accounting,OU=Staff,DC=acme,DC=example";
const GROUPS = ["GG_Accounting", "GG_Printers_Floor1", "GG_Share_Accounting"];
const newUser = await conversation(
  "New domain account for Giulia Rossi",
  2,
  [
    [
      "Giulia Rossi joins Accounting tomorrow as accounts clerk. Can you create her domain account with the same groups as Marta Bianchi?",
      [
        { text: "First Marta Bianchi's account and groups, then whether Giulia already has one." },
        {
          command:
            "Get-ADUser mbianchi -Properties Department, Title | Select-Object Name, SamAccountName, Department, Title, DistinguishedName",
          reason: "See Marta Bianchi's department, title and organizational unit",
          target: onDc01,
          output: `Name              : Marta Bianchi\nSamAccountName    : mbianchi\nDepartment        : Accounting\nTitle             : Accounts clerk\nDistinguishedName : CN=Marta Bianchi,${OU}`,
        },
        {
          command: "Get-ADPrincipalGroupMembership mbianchi | Select-Object -ExpandProperty Name",
          reason: "List the groups Marta Bianchi is in",
          target: onDc01,
          output: ["Domain Users", ...GROUPS].join("\n"),
        },
        {
          command: `Get-ADUser -Filter "SamAccountName -eq 'grossi'"`,
          reason: "Check that no grossi account exists yet",
          target: onDc01,
          output: "",
        },
      ],
    ],
  ],
  {
    plan: {
      title: "Create the domain account of Giulia Rossi",
      summary: `Create grossi in ${OU}, disabled, add it to the groups of mbianchi, then check.`,
      text: `Marta Bianchi is in ${OU} and, besides Domain Users, in ${GROUPS.join(", ")}. There is no grossi account yet.\n\nI prepared a plan: create the account disabled, add the three groups, check them. The first password is yours to set: I never handle passwords. Nothing runs until you approve the plan.`,
      steps: [
        {
          target: onDc01,
          command: `New-ADUser -Name "Giulia Rossi" -GivenName Giulia -Surname Rossi -SamAccountName grossi -UserPrincipalName grossi@acme.example -Path "${OU}" -Department Accounting -Title "Accounts clerk" -Enabled $false`,
          reason: "Create the account, disabled until IT sets the first password",
          timeoutSeconds: 60,
        },
        ...GROUPS.map((group) => ({
          target: onDc01,
          command: `Add-ADGroupMember ${group} -Members grossi`,
          reason: `Add Giulia Rossi to ${group}, as Marta Bianchi`,
          timeoutSeconds: 60,
        })),
        {
          target: onDc01,
          command: "Get-ADPrincipalGroupMembership grossi | Select-Object -ExpandProperty Name",
          reason: "Check the groups of the new account",
          timeoutSeconds: 60,
        },
      ],
    },
  },
);
const adSummary = `Done: grossi is in ${OU}, disabled, and in ${GROUPS.join(", ")}, as Marta Bianchi.\n\nTwo things are left for you, outside Orlok: in Active Directory Users and Computers set the first password with “User must change password at next logon”, then enable the account.`;
const adCandidates = [
  {
    title: "New domain account with the groups of a colleague",
    summary:
      "Read the groups of a colleague in the same job with Get-ADPrincipalGroupMembership, create the account disabled with New-ADUser, add the groups with Add-ADGroupMember, then set the first password and enable the account in Active Directory Users and Computers.",
    slug: null,
  },
];

// A review item and its "Fix with Ada": still open and the newest, so at the top of Review, for
// the video sequence (list, request written, conversation); the conversation shows Ada fixing it.
const [retention] = await db
  .insert(wikiReviewItems)
  .values({
    officeId: it.id,
    kind: "contradiction",
    title: "Two retention periods for the database dump",
    detail: "[[db-01]] says 14 days, [[database-backups]] says 30 days.",
    slugs: ["db-01", "database-backups"],
    raisedByColleagueId: ada.id,
  })
  .returning();
if (!retention) throw new Error("Review item insert returned no row");
const fix = await conversation(
  "Two retention periods for the database dump",
  60 * 3 + 5,
  [
    [
      // What "Fix with Ada" writes for this item (fixPrompt in WikiReview.tsx).
      "Help me with this item of the wiki review: “Two retention periods for the database dump” (Contradiction).\ndb-01 says 14 days, Database backups says 30 days.\n\nExplain the problem, propose a fix and, once I agree, fix the pages and close the item.",
      [
        {
          text: "The two pages disagree on how long the nightly dumps are kept. [[database-backups]] records that the retention went from 14 to 30 days after the September audit, while [[db-01]] still says 14 days: it was simply not updated.\n\nI propose to change [[db-01]] to 30 days and link it to the backup procedure, so the number lives in one place.",
        },
      ],
    ],
    [
      "Yes, go ahead.",
      [
        {
          text: "Done: [[db-01]] now says the dumps are kept 30 days, as in [[database-backups]], and the review item is closed.",
        },
      ],
    ],
  ],
  { wikiEdits: [{ slug: "db-01", title: "db-01", action: "update" }] },
);
await savePageRevision(
  db,
  db01Revised,
  {
    content: db01Revised.content.replace(
      "kept 14 days.",
      "kept 30 days (see [[database-backups]]).",
    ),
  },
  { colleagueId: ada.id, origin: { conversationId: fix.id } },
  "Retention is 30 days since the September audit",
);

// A plan waiting for approval, in its own conversation.
const [planConversation] = await db
  .insert(conversations)
  .values({
    colleagueId: ada.id,
    userId: alex.id,
    title: "Load the new nginx redirect",
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(28),
  })
  .returning();
if (!planConversation) throw new Error("Conversation insert returned no row");
await db.insert(messages).values({
  conversationId: planConversation.id,
  role: "user",
  content:
    "I added the redirect from /shop to /store in the nginx config on web-01. Can you load it safely?",
  createdAt: minutesAgo(30),
});
const plan = await requestPlan(db, {
  officeId: it.id,
  colleagueId: ada.id,
  conversationId: planConversation.id,
  userId: alex.id,
  title: "Load the new nginx configuration on web-01",
  summary: "Test the configuration, reload nginx without dropping connections, check the site.",
  steps: [
    { target: onWeb01, command: "sudo nginx -t", reason: "Check the syntax", timeoutSeconds: 60 },
    {
      target: onWeb01,
      command: "sudo systemctl reload nginx",
      reason: "Load the new configuration",
      timeoutSeconds: 60,
    },
    {
      target: onWeb01,
      command: "curl -sI https://www.example.com/shop",
      reason: "Check the redirect answers",
      timeoutSeconds: 60,
    },
  ],
  policy: { mode: "ask" },
});
await db
  .update(opsPlans)
  .set({ createdAt: minutesAgo(29) })
  .where(eq(opsPlans.id, plan.plan.id));
await db.insert(messages).values({
  conversationId: planConversation.id,
  role: "assistant",
  content: "",
  model: LARGE,
  inputTokens: 15_200,
  outputTokens: 410,
  opsJobIds: plan.jobs.map((job) => job.id),
  parts: [
    {
      type: "text",
      text: "Following [[nginx-config-changes]], I prepared three steps: test, reload, check. Nothing runs until you approve the plan.",
    },
    ...plan.jobs.map((job): MessagePart => ({ type: "job", jobId: job.id })),
  ],
  createdAt: minutesAgo(29),
});

// The office colleague answering from the wiki, in a conversation of its own.
const [guideConversation] = await db
  .insert(conversations)
  .values({
    colleagueId: guide.id,
    userId: alex.id,
    title: "VPN from home",
    createdAt: minutesAgo(20),
    updatedAt: minutesAgo(19),
  })
  .returning();
if (!guideConversation) throw new Error("Conversation insert returned no row");
await db.insert(messages).values({
  conversationId: guideConversation.id,
  role: "user",
  content: "I'm working from home tomorrow. How do I get on the VPN?",
  createdAt: minutesAgo(20),
});
await db.insert(messages).values({
  conversationId: guideConversation.id,
  role: "assistant",
  content: "",
  model: LOCAL,
  inputTokens: 4_100,
  outputTokens: 260,
  parts: [
    {
      type: "text",
      text: "Here is how, from [[connect-to-vpn]]:\n\n1. Install **WireGuard** from the company portal. If your laptop came from IT, it is already there.\n2. Go to https://vpn.acme.example, sign in with your Acme account and download your profile.\n3. In WireGuard, choose *Import tunnel from file* and pick that file.\n4. Turn the **Acme** tunnel on.\n5. To check it works, open https://intranet.example.com.\n\nThe profile lasts 90 days: when it expires, download a new one as in step 2. If the portal does not accept your account, ask IT.",
    },
  ],
  createdAt: minutesAgo(19),
});

// --- A month of model usage, and the limits ------------------------------------------------

const usage: (typeof modelUsage.$inferInsert)[] = [];
const days = Math.max(1, new Date(now).getUTCDate());
let seed = 7;
const random = () => {
  seed = (seed * 16_807) % 2_147_483_647;
  return seed / 2_147_483_647;
};
const workers = [
  { colleague: ada, user: alex, office: it, model: LARGE, provider: cloud, calls: 9 },
  {
    colleague: colleague("Linus"),
    user: alex,
    office: it,
    model: BUDGET,
    provider: budget,
    calls: 6,
  },
  { colleague: ada, user: alex, office: it, model: SMALL, provider: cloud, calls: 3 },
  {
    colleague: colleague("Grace"),
    user: sam,
    office: it,
    model: LARGE,
    provider: cloud,
    calls: 6,
  },
  {
    colleague: colleague("Iris"),
    user: alex,
    office: finance,
    model: LOCAL,
    provider: local,
    calls: 4,
  },
];
for (let day = 0; day < days; day++) {
  for (const worker of workers) {
    const calls = Math.round(worker.calls * (0.4 + random()));
    for (let call = 0; call < calls; call++) {
      const tokens = {
        inputTokens: Math.round(6_000 + random() * 20_000),
        cachedInputTokens: Math.round(random() * 12_000),
        cacheWriteTokens: Math.round(random() * 2_000),
        outputTokens: Math.round(200 + random() * 1_200),
      };
      const rates = RATES[worker.model] ?? null;
      usage.push({
        officeId: worker.office.id,
        userId: worker.user.id,
        colleagueId: worker.colleague.id,
        purpose: random() < 0.85 ? "chat" : "wiki_filing",
        providerId: worker.provider.id,
        providerName: worker.provider.name,
        model: worker.model,
        ...tokens,
        costStatus: rates ? "priced" : "included",
        costMicros: rates ? costMicros(tokens, rates) : null,
        rates,
        createdAt: minutesAgo((days - 1 - day) * 24 * 60 + Math.round(random() * 600)),
      });
    }
  }
}
await db.insert(modelUsage).values(usage);
await db.insert(budgets).values([
  { scope: "installation", monthlyLimitMicros: 150_000_000, warnPercent: 80 },
  { scope: "office", officeId: it.id, monthlyLimitMicros: 120_000_000, warnPercent: 80 },
]);

await close();
if (values.paths) {
  const chat = (id: string) => `/colleagues/${ada.id}/${id}`;
  await writeFile(
    values.paths,
    `${JSON.stringify(
      {
        chat: chat(spooler.id),
        plan: chat(planConversation.id),
        "wiki-page": `/offices/${it.id}/wiki/disk-space-web-01`,
        "wiki-review": `/offices/${it.id}/wiki/_review`,
        profiles: "/admin/profiles",
        costs: "/admin/costs",
        // The person's own access and what they allowed always (Account), for the trust story.
        credentials: "/account#account-credentials-title",
        "command-types": "/account#account-command-types-title",
        // The office colleague (R-ADM-8): its conversation, and its section in Admin → Offices.
        "office-colleague": `/colleagues/${guide.id}/${guideConversation.id}`,
        "office-colleague-admin": `/admin/offices#office-${it.id}`,
      },
      null,
      2,
    )}\n`,
  );
  // The screens of the website videos and the commands that run in them (shoot-video.mjs).
  await writeFile(
    values.paths.replace(/(\.json)?$/, "-video.json"),
    `${JSON.stringify(
      {
        office: it.id,
        ada: ada.id,
        disk: chat(disk.id),
        spooler: chat(spooler.id),
        dbHealth: { route: chat(dbHealth.id), jobs: dbHealth.held, prompt: dbHealth.prompt },
        branch: { route: chat(branch.id), jobs: branch.held, prompt: branch.prompt },
        diskPrompt: disk.prompt,
        ad: {
          route: chat(newUser.id),
          conversation: newUser.id,
          prompt: newUser.prompt,
          summary: adSummary,
          candidates: adCandidates,
        },
        fix: chat(fix.id),
        wiki: `/offices/${it.id}/wiki`,
      },
      null,
      2,
    )}\n`,
  );
}
console.log(
  `Demo data ready: sign in as alex.morgan@acme.example with the password given (default demo-password-acme). Conversations: ${spooler.id} (approval), ${planConversation.id} (plan).`,
);
