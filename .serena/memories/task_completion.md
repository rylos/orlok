# Task completion

From the root, all must pass with no errors or warnings:
1. `pnpm check` then `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test` (server tests use a real Postgres: needs `pnpm db:up`; the `orlok_test` DB is created and migrated by `apps/server/src/test/global-setup.ts`)
4. `pnpm build` (tsdown must not print WARN)
5. (no client module yet: it will be Rust, R-OPS-8)
6. If the DB schema changed: migration generated and committed (`apps/server/drizzle/`)
7. If the UI changed: check a light and a dark theme (latte, mocha — all of them are listed in `packages/shared/src/theme.ts`), both languages (en, it) and ~400px width; every new string exists in all locales. If colours changed, check the contrast of the pairs that carry text (foreground/background, muted-foreground/muted, primary-foreground/primary, destructive-foreground/destructive) across every theme, not by eye
8. If requirements changed: `docs/REQUIREMENTS.md` consistent; if commands or layout changed: `README.md`
9. Everything written in English (see `mem:conventions`); no company-specific data in the product (see `mem:core`)
