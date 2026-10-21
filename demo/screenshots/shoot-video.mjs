// Screens for the website videos (orlok.xyz): the same demo as shoot.mjs, step by step, at
// 1440x900, each video in one theme of its own. It clicks like a person would (always allow, save
// to the wiki, import, fix with Ada), so run it once per video on a freshly seeded demo whose app
// uses demo-runner.mjs:
//
//   node shoot-video.mjs --paths paths-video.json --only v1 --theme mocha
//   node shoot-video.mjs --paths paths-video.json --only v2 --theme latte
//   node shoot-video.mjs --paths paths-video.json --only ad --theme tokyo-night --out ../output/video-ad
//
// The commands the seed holds back are queued again just before their screen, straight in the
// demo database through `docker exec <db container> psql`.

import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3999" },
    paths: { type: "string", default: "paths-video.json" },
    out: { type: "string", default: "../output/video" },
    email: { type: "string", default: "alex.morgan@acme.example" },
    password: { type: "string", default: "demo-password-acme" },
    "db-container": { type: "string", default: "orlok-demo-db-1" },
    "db-name": { type: "string", default: "orlok_demo" },
    // "v1" or "v2" to take the screens of one video only; "ad" for the Active Directory one,
    // which runs only when asked (--only ad --out ../output/video-ad).
    only: { type: "string" },
    // An Orlok theme id: mocha, latte, tokyo-night, tokyo-night-light...
    theme: { type: "string", default: "mocha" },
  },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const screens = JSON.parse(await readFile(values.paths, "utf8"));
await mkdir(values.out, { recursive: true });

function psql(sql) {
  execFileSync("docker", [
    "exec",
    values["db-container"],
    "psql",
    "-U",
    "orlok",
    "-d",
    values["db-name"],
    "-c",
    sql,
  ]);
}
// Text for SQL, dollar-quoted so the demo texts need no escaping.
const literal = (text) => `$demo$${text}$demo$`;
const uuid = (id) => `'${id.replace(/[^0-9a-f-]/g, "")}'`;

// Lets the held commands of a conversation run: the app's worker picks them up within seconds.
// With `allowedType` they run as an always-allowed type would: the seed stored them before the
// approval existed, as asking, so their card would not say why they did not ask.
function release(jobIds, allowedType) {
  const ids = jobIds.map(uuid).join(",");
  const allowed = allowedType
    ? `, classification = classification || '${JSON.stringify({
        decision: "allow",
        matchedRules: [`type:${allowedType.replace(/[^A-Za-z-]/g, "")}`],
      })}'::jsonb`
    : "";
  psql(
    `update ops_jobs set status = 'queued', started_at = null, finished_at = null${allowed} where id in (${ids})`,
  );
}

const theme = values.theme;
const light = ["latte", "rose-pine", "tokyo-night-light"].includes(theme);

const browser = await chromium.launch({ args: ["--lang=en-US"] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: light ? "light" : "dark",
  locale: "en-US",
});
await context.addInitScript((name) => {
  localStorage.setItem("orlok-locale", "en");
  localStorage.setItem("orlok-theme", name);
}, theme);
const login = await context.request.post(`${values.url}/api/auth/login`, {
  data: { email: values.email, password: values.password, remember: true },
});
if (!login.ok()) throw new Error(`Sign-in failed: ${login.status()}`);
await context.request.patch(`${values.url}/api/me/preferences`, {
  data: { themePreference: theme, locale: "en" },
});
const page = await context.newPage();

async function open(route) {
  await page.goto(`${values.url}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}
async function shot(name) {
  const file = path.join(values.out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
// A new, empty conversation with the colleague of the open chat, with `text` typed and not sent.
// The conversation the request will become is in the seed already: opening it added its tab,
// which is closed again, since before the message is sent that conversation does not exist.
async function typedRequest(route, text) {
  await open(route);
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.waitForTimeout(800);
  const id = route.split("/").pop();
  const tab = page.locator(`[data-tab-id="${id}"] button[aria-label^="Close"]`);
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(300);
  }
  if (text) {
    await page.getByRole("textbox").last().fill(text);
    await page.waitForTimeout(300);
  }
}
// The badge of the last command card in the conversation.
const lastBadge = (status) => page.getByText(status, { exact: true }).last();
// Until no command of the conversation is running any more (the badge may add "· 2 lines so far").
const finished = () =>
  page
    .getByText(/^Running( · \d+ lines? so far)?$/)
    .first()
    .waitFor({ state: "detached", timeout: 30_000 });

try {
  // --- Video 1: approvals ------------------------------------------------------------------
  if (!values.only || values.only === "v1") {
    // The request, before and after typing it.
    await typedRequest(screens.dbHealth.route, "");
    await shot("v1-00a-empty-chat");
    await typedRequest(screens.dbHealth.route, screens.dbHealth.prompt);
    await shot("v1-00-request-typed");

    // A read command runs without asking: running, then done, then opened on its output.
    release(screens.dbHealth.jobs);
    await open(screens.dbHealth.route);
    // Once it has written a line, so the card shows it is not stuck.
    await page
      .getByText(/^Running · \d+ lines? so far$/)
      .last()
      .waitFor({ timeout: 15_000 });
    await shot("v1-01-read-running");
    await finished();
    await page.waitForTimeout(500);
    await shot("v1-02-read-done");
    await page.getByRole("button", { name: /du -sh/ }).click();
    await page.getByRole("button", { name: "Output" }).last().click();
    await page.waitForTimeout(300);
    await shot("v1-03-read-output");

    // A restart asks; "Always allow" lets it run, and approves Restart-Service for Alex.
    await open(screens.spooler);
    await shot("v1-04-approval-strip");
    await page.getByRole("button", { name: "Always allow" }).click();
    await page.waitForTimeout(700);
    await shot("v1-05-after-always-allow");
    await lastBadge("Running").waitFor({ timeout: 15_000 });
    await shot("v1-06-always-allow-running");
    await finished();
    await page.waitForTimeout(500);
    await shot("v1-07-always-allow-done");

    // The same restart on the branch server now runs without asking.
    await typedRequest(screens.branch.route, "");
    await shot("v1-07a-empty-chat");
    await typedRequest(screens.branch.route, screens.branch.prompt);
    await shot("v1-07b-branch-request-typed");
    release(screens.branch.jobs, "Restart-Service");
    await open(screens.branch.route);
    await lastBadge("Running").waitFor({ timeout: 15_000 });
    await shot("v1-08-approved-type-running");
    await finished();
    await page.waitForTimeout(500);
    await shot("v1-09-approved-type-done");
    await page.getByRole("button", { name: /Restart-Service Spooler/ }).click();
    await page.waitForTimeout(300);
    await shot("v1-10-approved-type-open");
  }

  // --- Video 2: wiki -----------------------------------------------------------------------
  if (!values.only || values.only === "v2") {
    // Import of a folder of notes: before, files chosen, while importing, the summary.
    await open(`${screens.wiki}/_import`);
    await page.getByText("Markdown folder").scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    await shot("v2-01-import");
    const notes = [
      "Office VPN.md",
      "Guest Wi-Fi.md",
      "New starter checklist.md",
      "Badge reader.md",
    ];
    await page
      .locator('input[type="file"][accept*="application/zip"]')
      .setInputFiles(notes.map((name) => path.join(here, "import-notes", name)));
    await page.getByText("Markdown files ready: 4").waitFor();
    await page.getByRole("button", { name: "Import", exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("v2-02-import-ready");
    // The import takes a moment on a real wiki; held a little here so the screen can be taken.
    await page.route("**/wiki/import", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.waitForTimeout(600);
    await shot("v2-03-importing");
    await page.getByText(/^Created \d+/).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot("v2-04-import-done");
    await page.unroute("**/wiki/import");
    await open(`${screens.wiki}/office-vpn`);
    await shot("v2-05-imported-page");

    // What the colleague proposes to keep: one let go, then the last one saved.
    await typedRequest(screens.disk, "");
    await shot("v2-05a-empty-chat");
    await typedRequest(screens.disk, screens.diskPrompt);
    await shot("v2-05b-request-typed");
    await open(screens.disk);
    await page.getByText("Worth keeping in the wiki?").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("v2-06-proposals");
    const proposals = page.locator('section[aria-labelledby="wiki-candidates"]');
    await proposals.getByRole("button", { name: "Let it go" }).first().click();
    await page.waitForTimeout(800);
    await shot("v2-07-proposal-let-go");
    await proposals.getByRole("button", { name: "Save to the wiki" }).first().click();
    await page.getByText("Sent to be filed into the wiki").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot("v2-08-proposal-saved");

    // On the way to the history: the wiki in the sidebar, then History on the page.
    await page.getByRole("link", { name: "Wiki", exact: true }).nth(1).hover();
    await page.waitForTimeout(300);
    await shot("v2-08b-to-the-wiki");
    await open(`${screens.wiki}/db-01`);
    await page.getByText("History", { exact: true }).first().hover();
    await page.waitForTimeout(300);
    await shot("v2-08c-to-the-history");

    // History of a page: the list of revisions, one opened.
    await open(`${screens.wiki}/db-01/history`);
    await shot("v2-09-history");
    await open(`${screens.wiki}/db-01/history?rev=3`);
    await shot("v2-10-history-revision-3");
    await open(`${screens.wiki}/db-01/history?rev=2`);
    await shot("v2-11-history-revision-2");

    // The graph and its insights.
    await open(`${screens.wiki}/_graph`);
    await page.waitForTimeout(2500);
    // The first frame leaves part of the graph under the zoom buttons: one step back shows it all.
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.waitForTimeout(800);
    await shot("v2-12-graph");
    await shot("v2-13-graph-insights");
    await page
      .getByText(/^Bridge pages/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("v2-13b-graph-bridges");
    await page
      .getByText(/^Isolated pages/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("v2-13c-graph-isolated");

    // Review, "Fix with Ada", and how a change by the colleague shows in the chat.
    await open(`${screens.wiki}/_review`);
    await shot("v2-14-review");
    // The item about the two retention periods, the one the fix conversation is about.
    await page
      .locator("li")
      .filter({ hasText: "Two retention periods" })
      .getByRole("button", { name: "Fix with Ada" })
      .click();
    await page.waitForTimeout(1500);
    await shot("v2-15-fix-with-ada");
    // The message box keeps its height and scrolls: the end of the request.
    await page.getByRole("textbox").last().press("Control+End");
    await page.waitForTimeout(300);
    await shot("v2-15b-fix-with-ada-end");
    await open(screens.fix);
    await shot("v2-16-fix-conversation");

    // A page with a passage marked as superseded.
    await open(`${screens.wiki}/database-backups`);
    await shot("v2-17-superseded");
  }

  // --- Video 3: a new domain account in Active Directory -------------------------------------
  if (values.only === "ad") {
    const ad = screens.ad;
    await typedRequest(ad.route, "");
    await shot("ad-00-empty-chat");
    await typedRequest(ad.route, ad.prompt);
    await shot("ad-01-request-typed");

    // Ada read without asking and planned the changes: the plan waits in the approval strip.
    // While the strip is open it takes most of the screen: what Ada read shows whole in ad-08.
    await open(ad.route);
    await shot("ad-02-plan-waiting");
    await page.getByRole("button", { name: /Get-ADPrincipalGroupMembership mbianchi/ }).click();
    await page.getByRole("button", { name: "Output" }).last().click();
    await page.waitForTimeout(300);
    await shot("ad-03-groups-read");
    await open(ad.route);
    await page.getByRole("button", { name: "Approve the whole plan" }).first().hover();
    await page.waitForTimeout(300);
    await shot("ad-04-approve-plan");

    // Approved once: the steps run one after the other.
    await page.getByRole("button", { name: "Approve the whole plan" }).first().click();
    await page.waitForTimeout(700);
    await shot("ad-05-plan-approved");
    await lastBadge("Running").waitFor({ timeout: 15_000 });
    await shot("ad-06-plan-running");
    await page
      .getByText(/^Running · \d+ lines? so far$/)
      .last()
      .waitFor({ timeout: 90_000 });
    await shot("ad-07-plan-checking");
    await page.getByText("Done", { exact: true }).last().waitFor({ timeout: 30_000 });
    await finished();
    await page.waitForTimeout(800);
    await shot("ad-08-plan-done");

    // Ada's summary, with what is left to a person: the first password and enabling the account.
    // No model answers in the demo: the app's attempt to go on ends in an error, which the script
    // replaces with what Ada would write.
    await page
      .getByText("The model provider returned an error")
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    psql(
      `delete from messages where conversation_id = ${uuid(ad.conversation)} and status = 'error'`,
    );
    psql(
      `insert into messages (conversation_id, role, content, model, parts) values (${uuid(ad.conversation)}, 'assistant', ${literal(ad.summary)}, 'large-v5', ${literal(JSON.stringify([{ type: "text", text: ad.summary }]))}::jsonb)`,
    );
    await open(ad.route);
    await shot("ad-09-summary");

    // What Ada proposes to keep: the procedure, saved to the wiki.
    psql(
      `update conversations set wiki_candidates = ${literal(JSON.stringify(ad.candidates))}::jsonb where id = ${uuid(ad.conversation)}`,
    );
    await open(ad.route);
    await page.getByText("Worth keeping in the wiki?").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("ad-10-proposal");
    await page
      .locator('section[aria-labelledby="wiki-candidates"]')
      .getByRole("button", { name: "Save to the wiki" })
      .click();
    await page.getByText("Sent to be filed into the wiki").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot("ad-11-proposal-saved");
  }
} finally {
  await browser.close();
}
