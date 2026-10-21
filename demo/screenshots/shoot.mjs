// Screenshots of a demo Orlok for the website (orlok.xyz), English interface only.
//
//   cd demo/screenshots && npm install && npx playwright install chromium
//   node shoot.mjs --url http://127.0.0.1:3999 --paths paths.json --out ../output/site
//
// The app must show the data of `../seed/demo-seed.ts` (fictional company Acme),
// which also writes paths.json: never point this at an installation with real data. Each screen is
// taken at 1440x900 in the two themes of the site, Tokyo Night (`<name>-dark.png`) and Tokyo Night
// Light (`<name>-light.png`), the chat also at 390x844. The chat shows a few conversation tabs, one
// of them waiting for an approval.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3999" },
    paths: { type: "string", default: "paths.json" },
    out: { type: "string", default: "../output/site" },
    email: { type: "string", default: "alex.morgan@acme.example" },
    password: { type: "string", default: "demo-password-acme" },
  },
});

// The site keeps only the two Tokyo Night themes and shows each screen in the one it is in
// (decided on 2026-10-16).
const THEMES = [
  { theme: "tokyo-night", mode: "dark" },
  { theme: "tokyo-night-light", mode: "light" },
];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const screens = JSON.parse(await readFile(values.paths, "utf8"));
await mkdir(values.out, { recursive: true });

// The browser draws some controls (the month picker) in its own language, not the page's.
const browser = await chromium.launch({ args: ["--lang=en-US"] });
try {
  const screensOnce = [
    ...Object.entries(screens).map(([name, route]) => ({ name, route, viewport: DESKTOP })),
    { name: "chat-phone", route: screens.chat, viewport: PHONE, phone: true },
  ];
  const shots = THEMES.flatMap((look) => screensOnce.map((shot) => ({ ...shot, ...look })));
  for (const shot of shots) {
    const { theme, mode } = shot;
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: 2,
      colorScheme: mode,
      locale: "en-US",
      isMobile: shot.phone ?? false,
      hasTouch: shot.phone ?? false,
      // A browser as people have it: the signed-in devices list (Account) shows its name.
      ...(shot.phone
        ? {}
        : {
            userAgent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
          }),
    });
    // The interface language and theme, as the person chose them on this device and in the
    // profile (R-UI-3, R-I18N-2).
    await context.addInitScript(
      ([themeId]) => {
        localStorage.setItem("orlok-locale", "en");
        localStorage.setItem("orlok-theme", themeId);
      },
      [theme],
    );
    const login = await context.request.post(`${values.url}/api/auth/login`, {
      data: { email: values.email, password: values.password, remember: true },
    });
    if (!login.ok()) throw new Error(`Sign-in failed: ${login.status()}`);
    await context.request.patch(`${values.url}/api/me/preferences`, {
      data: { themePreference: theme, locale: "en" },
    });
    const page = await context.newPage();
    // The chat on a computer with the tabs a person would have: the plan waiting for approval
    // and another conversation opened before it.
    if (shot.name === "chat") {
      await page.goto(`${values.url}${screens.plan}`, { waitUntil: "networkidle" });
      const colleagueId = screens.chat.split("/")[2];
      const listed = await (
        await context.request.get(`${values.url}/api/conversations?colleagueId=${colleagueId}`)
      ).json();
      const other = listed.find(
        (item) =>
          !item.waiting && !screens.chat.endsWith(item.id) && !screens.plan.endsWith(item.id),
      );
      if (other) {
        await page.goto(`${values.url}/colleagues/${colleagueId}/${other.id}`, {
          waitUntil: "networkidle",
        });
      }
    }
    // The plan with the chat beside it, also waiting.
    if (shot.name === "plan") {
      await page.goto(`${values.url}${screens.chat}`, { waitUntil: "networkidle" });
    }
    await page.goto(`${values.url}${shot.route}`, { waitUntil: "networkidle" });
    // Fonts, highlighted code and the approval strip settle after the data arrives.
    await page.waitForTimeout(1500);
    // A section of a long page (Account): its heading at the top of the screen.
    const anchor = shot.route.split("#")[1];
    if (anchor) {
      await page.locator(`#${anchor}`).evaluate((element) => {
        // Only the page's own scrolling box moves, so the header stays where it is.
        let box = element.parentElement;
        while (box && box.scrollHeight <= box.clientHeight + 1) box = box.parentElement;
        if (box) {
          const offset = element.getBoundingClientRect().top - box.getBoundingClientRect().top;
          box.scrollTop += offset - 24;
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(300);
    }
    // The signed-in devices list shows browser strings that say nothing on the site.
    if (shot.name === "command-types") {
      await page.addStyleTag({
        content: 'section[aria-labelledby="account-sessions-title"] { display: none !important; }',
      });
      await page.waitForTimeout(200);
    }
    const file = path.join(values.out, `${shot.name}-${mode}.png`);
    await page.screenshot({ path: file });
    console.log(file);
    await context.close();
  }
} finally {
  await browser.close();
}
