# Agent guidelines

Notes for AI coding agents (Copilot CLI, Claude, etc.) working in this repo.

## Before you change code — read CONTRIBUTING once per session

The first time in a session that you're about to create or modify a file, read
[CONTRIBUTING.md](CONTRIBUTING.md) if you haven't already. It is the canonical
source for this repo's conventions — testing expectations (add/update tests with
behavior changes), how unit vs e2e tests are structured, style/formatting, and
the `pnpm run verify` quality gate. You don't need to re-read it on every edit;
once per session is enough. The essentials you need constantly are inlined below;
CONTRIBUTING.md is the detail for the long tail.

## Common commands — prefer the package scripts

Always reach for the `package.json` scripts instead of invoking the underlying
binaries via `pnpm exec` / `npx`. The portal's permission gateway tends to
auto-approve the well-known script names and prompt for raw `pnpm exec` calls,
so this is both faster and less noisy for the user.

| Want to…          | Use                             | Not                            |
| ----------------- | ------------------------------- | ------------------------------ |
| Format the repo   | `pnpm format`                   | `pnpm exec prettier --write .` |
| Check formatting  | `pnpm lint`                     | `pnpm exec prettier --check .` |
| Typecheck         | `pnpm check`                    | `pnpm exec svelte-check ...`   |
| Run unit tests    | `pnpm test`                     | `pnpm exec vitest run`         |
| Run a single test | `pnpm test <path>`              | `pnpm exec vitest run <path>`  |
| E2E tests         | `pnpm test:e2e`                 | `pnpm exec playwright test`    |
| Run the full gate | `pnpm run verify`               | running each phase by hand     |
| Dev server        | `pnpm dev:isolated` (see below) | `pnpm dev`                     |

If you genuinely need a flag the script doesn't pass through, it's fine to fall
back to `pnpm exec` — but check `package.json` first; the script usually exists.

When you change behavior, add or update tests in the same change, then run
`pnpm test <path>` for the file you touched and `pnpm run verify` before
declaring the work done. See [CONTRIBUTING.md](CONTRIBUTING.md) for unit-vs-e2e
conventions, fixtures, and the process-isolation setup.

## Local testing — use an isolated data dir

**Do not** run `pnpm dev` against the default `./data` when doing exploratory
work (Playwright probes, curl-driven API testing, scratch conversations,
etc.). The portal's `AUTH_MODE=none` fallback creates a single shared
"local-dev" user, so any conversations/messages a test creates land in the
same sidebar the human user sees in their real session — polluting the live
DB with junk.

Use the isolated dev server instead:

```
pnpm dev:isolated         # spins up vite dev with a fresh tmp DATA_DIR
pnpm dev:isolated --port 5193
```

The script (`scripts/dev-isolated.mjs`) points `DATA_DIR` at a fresh temp
directory, sets `AUTH_MODE=none` with the required local-only guards, and
provides throwaway secrets. Real user data is untouched.

If you genuinely need to inspect the live DB, do it read-only via
`better-sqlite3` against `./data/portal.db` — don't write through API
endpoints, which mutate state under the live local user.

## When you are _yourself_ running through this portal

If your harness is `copilot --headless` and this portal is rendering your
chat, the same `InteractiveRequestDialog` you can read in `src/lib/components/`
**is the UI a user clicks to approve your tool calls**. A few corollaries
that are easy to miss otherwise:

- **A "rejection" with no message usually means the user never saw the
  prompt.** Common causes: SSE stream blip that cleared the dialog
  without rehydrating it, the user is on another page / tab, the request
  was cancelled by a turn-abort. The `interactive.resolved` event
  carries `cancelled: true` + `cancelReason` when this happens, and the
  settings audit panel records it as `auto-deny` — check there before
  assuming the user actually denied something.
- **There is no default timeout on prompts.** `DEFAULT_TIMEOUT_MS = 0`
  in `src/lib/server/runtime/interactive-requests.ts`; pending prompts
  wait indefinitely until the user answers or the turn is aborted. If a
  tool call appears to hang, the user simply hasn't clicked yet — don't
  chase it as a bug.
- **Auto-approvals are audited.** `bridge.ts` writes `auto-allow` /
  `auto-deny` rows to `permission_decisions` when the user's policy or a
  stored grant settles a request without a dialog. The settings page
  surfaces these — useful for confirming "did my recent grant actually
  fire?" without instrumenting code.
- **The portal's permissions UX (policy, grants, scope picker) is
  orthogonal to the Copilot CLI's own approval prompts.** If you're
  running outside the portal (regular CLI, no headless server), nothing
  in this repo affects which of your tool calls get auto-approved.
