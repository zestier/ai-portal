# Contributing

Notes for humans (and agents) changing this repo. For the day-to-day command
cheat-sheet and agent-specific gotchas, see [AGENTS.md](AGENTS.md); this file
covers conventions that don't fit in a table — chiefly **testing**.

## The quality gate

`pnpm run verify` runs the full gate (lint, `svelte-check`, unit tests, build,
Playwright e2e). It's what the `pre-commit` hook and the in-app redeploy run, so
a change that passes `verify` locally is a change that will commit and deploy
cleanly. Run it before opening a PR:

```bash
pnpm run verify                       # one phase at a time (default)
pnpm run verify -- --concurrency 3    # run up to three independent phases at once
```

To bypass the pre-commit hook for an emergency commit: `SKIP_VERIFY=1 git commit ...`.

## Testing

**Add tests when you add or change code.** Every bug fix should come with a test
that fails before the fix and passes after; every new behavior should come with
tests covering the happy path and the edge cases you thought about while writing
it. PRs that change behavior without touching tests will be asked "where's the
test?" — save the round-trip.

What "add a test" means in practice here:

- **Pure logic / server modules → a unit test.** Vitest, fast, no browser.
- **User-visible flows / API endpoints / cross-cutting request behavior → an e2e
  test.** Playwright against a real build with a stubbed Copilot backend.
- Most changes only need the first. Reach for e2e when the thing you changed can
  only really be exercised through an HTTP request or the rendered UI.

### Unit tests (Vitest)

- Live in `tests/` as `*.test.ts` (co-located `src/**/*.test.ts` also works; see
  the `include` glob in [`vite.config.ts`](vite.config.ts)). Name the file after
  the module under test — `tests/title.test.ts` covers `src/lib/server/title.ts`.
- Run them with `pnpm test` (whole suite) or `pnpm test tests/title.test.ts` (one
  file). `pnpm run test:watch` for a watch loop; `pnpm run test:coverage` for the
  v8 coverage report.
- Structure with `describe` / `it` and plain `expect` assertions. See
  [`tests/title.test.ts`](tests/title.test.ts) for the house style: one `describe`
  per exported function, small focused `it`s, and a comment on any assertion that
  encodes a deliberate trade-off (so the next person doesn't "fix" it blindly).
- The environment is Node (`environment: 'node'`), and each test **file** runs in
  its own forked process (`pool: 'forks'`, `isolate: true`) so module-level state
  — the config singleton, the SQLite handle, mocked modules — does not leak
  between files. Don't rely on state set up by another file.
- `tests/setup.ts` snapshots and restores `process.env` around every test, so you
  may freely set `DATA_DIR`, `AUTH_MODE`, etc. inside a test without cleaning up.
  Shared helpers (temp dirs, etc.) live in `tests/helpers/`.

### End-to-end tests (Playwright)

- Live in `e2e/` as `*.spec.ts`. Run with `pnpm run test:e2e` (builds first, then
  runs) or `pnpm run test:e2e:run` if `build/` is already current.
  `pnpm run test:e2e:ui` opens the Playwright UI.
- The e2e server runs the **production build** with `COPILOT_STUB=1`, so tests
  never hit the real Copilot backend — assert against the stub's deterministic
  behavior rather than live model output.
- Each run gets an isolated `DATA_DIR` (`e2e/.tmp-data`) and `AUTH_MODE=none`; the
  config in [`playwright.config.ts`](playwright.config.ts) documents the
  CSRF/Origin and `GIT_CEILING_DIRECTORIES` setup it relies on.
- For API-driven specs, import `test`/`expect` from
  [`e2e/helpers/fixtures.ts`](e2e/helpers/fixtures.ts) rather than
  `@playwright/test` directly — the custom `request` fixture primes the CSRF
  double-submit cookie/header the server's hooks require.

### Local manual testing

Don't run `pnpm dev` against the default `./data` for scratch/manual testing —
it pollutes the live local user's sidebar. Use `pnpm dev:isolated` (fresh temp
`DATA_DIR`). This is covered in more detail in [AGENTS.md](AGENTS.md).

## Style & formatting

Formatting and lint are enforced by `pnpm lint` (ESLint + Prettier check) and
fixed by `pnpm format` (Prettier write). Don't hand-format; let Prettier do it.
Comment code only where it needs clarification — prefer a one-line note on a
non-obvious trade-off over narrating what the code already says.

## Dependencies

Native / ABI-bound modules are pinned to an **exact** version (no `^`/`~`) in
`package.json`. For these packages a minor or patch bump can swap the prebuilt
binary or change runtime behavior in ways that don't surface until a different
environment installs them, so we don't want a fresh `pnpm install` to silently
float the version. `better-sqlite3` is the current example. Renovate/Dependabot
can still propose upgrades through a reviewed PR — pinning only removes the
implicit, unreviewed drift. Pure-JS dependencies may keep caret ranges.
