# Agent guidelines

Notes for AI coding agents (Claude Code, etc.) working in this repo.

## Repo skills

Repo-local skills formerly shipped in `agent-plugins/zap-skills/`; the runtime
no longer loads repo skill files, so the guidance lives in this file.

## Ticket-first workflow

This repo runs a **ticket-first** workflow, and the portal nudges every agent the
same way (see `PORTAL_SYSTEM_GUIDANCE` in
[`src/lib/server/runtime/system-guidance.ts`](src/lib/server/runtime/system-guidance.ts)).
Two layers are in play:

- **Portal layer (universal):** durable work belongs in tickets
  (`ticket_add` / `ticket_list` / `ticket_update`), with the plan and checklist in
  the ticket `plan` field — not a scratch markdown file. Start a non-trivial task
  by checking `ticket_list` and resuming the matching ticket before re-planning;
  file follow-up work as new tickets and link them with `ticket_block`. The
  session `todos` table is within-session scratch that mirrors the active ticket,
  not the source of truth.
- **Repo layer (this repo tightens it):** **every commit should map to a ticket.**
  Before you commit, make sure the work traces to one — resume an existing ticket
  or open one first, reference it in the ticket's plan checklist, and mark items
  done as you land them. Discovered work gets its own linked ticket rather than
  scope-creeping the current commit.

The payoff is durability: tickets outlive sessions, so the same work item can be
picked up across many sessions without reconstructing context from a dead one.

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

## Browser automation — use the Playwright CLI

Need to drive a real browser (manual checks, reproducing a UI bug, scraping a
page)? Use the **Playwright CLI** (`@playwright/cli`, a devDependency) rather
than a browser MCP server — it's the token-efficient path Microsoft recommends
for coding agents (concise commands instead of large tool schemas and
accessibility trees loaded into context). Discover the full command set from its
own help:

```
pnpm exec playwright-cli --help
```

Then drive a session, e.g.:

```
pnpm exec playwright-cli open https://example.com --browser firefox
pnpm exec playwright-cli snapshot          # accessibility snapshot with element refs
pnpm exec playwright-cli click <ref>
pnpm exec playwright-cli close
```

**Iterate visually — don't edit UI blind.** When you change anything visual
(CSS, layout, spacing, colors, a component's markup), close the loop with the
browser instead of guessing: render the affected page, `screenshot` it, look at
the result, adjust, and re-screenshot until it's right. The same loop is how you
catch regressions a unit test won't — overflow, contrast, broken wrapping,
dark-mode glitches. A typical pass:

```
pnpm exec playwright-cli open http://localhost:5193/<page> --browser firefox
pnpm exec playwright-cli screenshot        # eyeball it, tweak the code, repeat
```

Point it at your `pnpm dev:isolated` server (see below), and check the states
that matter for the change — narrow/wide viewport (`resize`), light/dark, and
any hover/focus/error states — not just the happy path.

Notes:

- This repo standardizes on **Firefox** (so do e2e tests); pass
  `--browser firefox`. If the browser isn't installed yet,
  `pnpm exec playwright install firefox` (the CLI also has `install-browser`).
- The CLI writes scratch artifacts (snapshots, console logs) under
  `.playwright-cli/`, which is gitignored.

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

If this portal is rendering your chat, the same `InteractiveRequestDialog`
you can read in `src/lib/components/`
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
- **Auto-approvals are audited.** `runtime/interactive-requests.ts` writes
  `auto-allow` / `auto-deny` rows to `permission_decisions` when the user's
  policy or a stored grant settles a request without a dialog. The settings
  page surfaces these — useful for confirming "did my recent grant actually
  fire?" without instrumenting code.
- **The portal's permissions UX (policy, grants, scope picker) is
  orthogonal to any approval prompts your own harness shows.** If you're
  running outside the portal (regular CLI), nothing
  in this repo affects which of your tool calls get auto-approved.
