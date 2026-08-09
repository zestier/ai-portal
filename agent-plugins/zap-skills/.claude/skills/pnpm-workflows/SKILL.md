---
name: pnpm-workflows
description: Run zap's pnpm scripts (format/lint/check/test/verify) instead of raw binaries — prefer package.json scripts over `pnpm exec`/`npx`, because the portal's permission gateway auto-approves the well-known script names.
---

# pnpm workflows

This repo uses `pnpm` with a package-script-first convention. Always reach for
the `package.json` scripts instead of invoking the underlying binaries via
`pnpm exec` / `npx` — the portal's permission gateway tends to auto-approve the
well-known script names and prompt for raw `pnpm exec` calls, so this is both
faster and less noisy for the user.

| Want to…          | Use                 | Not                            |
| ----------------- | ------------------- | ------------------------------ |
| Format the repo   | `pnpm format`       | `pnpm exec prettier --write .` |
| Check formatting  | `pnpm lint`         | `pnpm exec prettier --check .` |
| Typecheck         | `pnpm check`        | `pnpm exec svelte-check ...`   |
| Run unit tests    | `pnpm test`         | `pnpm exec vitest run`         |
| Run a single test | `pnpm test <path>`  | `pnpm exec vitest run <path>`  |
| E2E tests         | `pnpm test:e2e`     | `pnpm exec playwright test`    |
| Run the full gate | `pnpm run verify`   | running each phase by hand     |
| Dev server        | `pnpm dev:isolated` | `pnpm dev`                     |

If you genuinely need a flag the script doesn't pass through, it's fine to fall
back to `pnpm exec` — but check `package.json` first; the script usually exists.

## The quality gate

`pnpm run verify` runs lint, `svelte-check`, unit tests, the production build,
and Playwright e2e — the same gate the pre-commit hook and in-app redeploy run,
so a change that passes `verify` locally will commit and deploy cleanly. Run it
before declaring work done:

- `pnpm run verify` — one phase at a time (default)
- `pnpm run verify -- --concurrency 3` — up to three independent phases at once

When you change behavior, add or update tests in the same change, run
`pnpm test <path>` for the file you touched, then `pnpm run verify` before done.
See CONTRIBUTING.md for the unit-vs-e2e conventions.

## Dependency pinning

Native / ABI-bound modules (e.g. `better-sqlite3`) are pinned to an exact
version in `package.json` — no `^`/`~` — so a fresh `pnpm install` never
silently floats a version that changes the prebuilt binary. Keep it that way.
