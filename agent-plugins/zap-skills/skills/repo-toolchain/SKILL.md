---
name: repo-toolchain
description: Use whenever you run, build, test, format, typecheck, or serve this repo, or before declaring any task here done. Commands go through the package.json scripts (`pnpm format`/`lint`/`check`/`test`/`run verify`) instead of raw binaries, and exploratory work runs against `pnpm dev:isolated` rather than `pnpm dev` so scratch activity never pollutes the live `./data` DB.
---

# Repo toolchain

Any command that runs, builds, tests, or serves this repo goes through the
`package.json` scripts, not the underlying binaries via `pnpm exec`/`npx`. The
portal's permission gateway auto-approves the well-known script names and
prompts on raw `pnpm exec` calls, so scripts are faster and quieter for the
user.

| Want to…     | Use                 | Not                            |
| ------------ | ------------------- | ------------------------------ |
| Format       | `pnpm format`       | `pnpm exec prettier --write .` |
| Check format | `pnpm lint`         | `pnpm exec prettier --check .` |
| Typecheck    | `pnpm check`        | `pnpm exec svelte-check ...`   |
| Unit tests   | `pnpm test <path>`  | `pnpm exec vitest run <path>`  |
| E2E tests    | `pnpm test:e2e`     | `pnpm exec playwright test`    |
| Full gate    | `pnpm run verify`   | running each phase by hand     |
| Dev server   | `pnpm dev:isolated` | `pnpm dev`                     |

`pnpm run verify` runs lint, svelte-check, unit tests, the production build,
and Playwright e2e — the same gate the pre-commit hook and in-app redeploy run.
Run it before declaring work done. Fall back to `pnpm exec` only when the
script lacks a flag you need; check `package.json` first, the script usually
exists.

## Serving the app without polluting the live DB

Never `pnpm dev` against the default `./data` for exploratory work (Playwright
probes, curl-driven API tests, scratch conversations). The portal's
`AUTH_MODE=none` fallback creates one shared "local-dev" user, so scratch
conversations land in the same sidebar the human sees in their real session.
Use `pnpm dev:isolated` instead — it points `DATA_DIR` at a fresh temp
directory with throwaway secrets (pass a port with `--port 5193`). If you
genuinely need the live DB, inspect it read-only via `better-sqlite3` against
`./data/portal.db` — never write through API endpoints, which mutate state
under the live local user.

## Dependency pinning

Native / ABI-bound modules (`better-sqlite3`) are pinned to an exact version
in `package.json` — no `^`/`~` — so a fresh install never silently floats a
version that swaps the prebuilt binary. Keep it that way.
