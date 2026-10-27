# Orlok demo

A throwaway Orlok filled with a fictional company (Acme), for the website (orlok.xyz, repo
rylos/orlok-web) and for presentations, with the screens taken from it. Everything here is made
up: names, example.com, documentation addresses 192.0.2.0/24, command outputs. Never put real
data here, and never point the seed at a real installation. Nothing in `demo/` goes into the
app image (`.dockerignore`).

- `compose.yaml`: the demo environment, reachable only from this computer: database
  (127.0.0.1:5544), app `orlok:demo` (http://127.0.0.1:3999), fake runner.
- `setup.sh`: starts the environment and fills it with fresh data. The first run writes random
  secrets to `demo/.env` (never committed, never printed).
- `seed/demo-seed.ts`: the data (package `@orlok/demo-seed`). It uses the server code, so
  `pnpm typecheck` checks it with the rest: when the schema changes, fix it there.
- `screenshots/`: Playwright scripts. The site keeps only Tokyo Night and Tokyo Night Light and
  shows each screen in the theme it is in (decided on 2026-10-16; until then each subject
  had a theme of its own). `shoot.mjs` takes the 11 site screens in both, as `<name>-dark.png` and
  `<name>-light.png` (10 on a computer, the chat also on a phone; `--only` takes some of them;
  the chats show a few tabs, one waiting; the person's credentials and approved command types,
  in Mocha with the conversations, show that a colleague never does more than its person and
  that "always allow" can be taken back; `office-colleague` and `office-colleague-admin` show the
  Guide, IT's office colleague, answering from a wiki procedure and its section in *Admin →
  Offices*), `shoot-video.mjs` the screens of the approvals video
  (`--only v1`, Mocha) and of the wiki video (`--only v2 --theme latte`), and with `--only ad` the
  11 of the Active Directory video (a new domain account, made disabled: the first password is
  set by a person, never in a conversation).
  `demo-runner.mjs` stands in for the runner: made-up output after a few seconds.
  `import-notes/` are notes for the import screen, with fake passwords on purpose (the import
  removes them).
- Model and provider names in the seed are generic ("Cloud provider", "Large · Ask", `large-v5`…)
  so the site shows no brand (decided with the user on 2026-10-15).
- `output/site` also holds four frames copied from the video rounds, in both themes: `allowed`
  (v1-10), `import` (v2-05), `history` (v2-10) and `wiki-graph` (v2-12). They come from v1 and v2
  rounds run with `--theme tokyo-night` and `--theme tokyo-night-light` into a scratch folder
  (four fresh setups), while `output/video` keeps the Mocha and Latte rounds of 2026-10-15.
- `output/site`, `output/video` (v1 and v2) and `output/video-ad`: the screens, 2880x1800
  (1440x900 at 2x). Until 2026-10-14 every screen was taken twice, in Latte and in Mocha. Commit them after
  each round, so the history keeps the earlier versions. The office colleague screens
  (2026-10-27) are the exception: they were taken into a scratch folder and handed to the site
  only, since screenshots change nothing in the product (decided with the user).

## Run

From the repository root, after `pnpm install`:

    demo/setup.sh --build                # first time, or after app changes: builds orlok:demo
    cd demo/screenshots && npm install && npx playwright install chromium   # once
    node shoot.mjs --paths paths.json    # site screens → ../output/site
    node shoot.mjs --paths paths.json --only office-colleague,office-colleague-admin --out <folder>

    demo/setup.sh                        # again before each video: the script uses up the demo state
    node shoot-video.mjs --paths paths-video.json --only v1 --theme mocha   # → ../output/video

    demo/setup.sh
    node shoot-video.mjs --paths paths-video.json --only v2 --theme latte

    demo/setup.sh
    node shoot-video.mjs --paths paths-video.json --only ad --theme tokyo-night --out ../output/video-ad

Sign in at http://127.0.0.1:3999 as `alex.morgan@acme.example` / `demo-password-acme` (a demo
password, shown on purpose). Stop it with `docker compose -f demo/compose.yaml down` (add `-v` to
drop the data).

The video script clicks like a person (always allow, save to the wiki, import, fix with Ada), and
sets the commands the seed holds back to queued just before their screen, through
`docker exec orlok-demo-db-1 psql`. So: one run per fresh seed. In the Active Directory video
no model answers after the plan, so the script replaces the app's error with Ada's summary and
her wiki proposal, both written in the seed. After changing `demo-runner.mjs`, restart it:
`docker restart orlok-demo-runner-1`.
