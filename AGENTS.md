# AGENTS.md

Guidelines for AI agents in this repo. Loaded at session start by zap (pi sessions) and CLI pi.

## Workflow

- **Ticket-first.** Non-trivial work: check `ticket_list`, resume matching ticket. Plan lives in ticket `plan`, not scratch files. Follow-up = new ticket, link via `blockedBy`/`blocks`. Session `todos` mirrors the active ticket, not source of truth.
- **Every commit maps to a ticket.** Open/resume one first, reference in plan, mark items done as they land.
- **Read CONTRIBUTING.md once per session** before first edit. Canonical for tests, style, and the `pnpm run verify` gate.

## Commands — prefer package scripts

Scripts auto-approve through the permission gateway; raw `pnpm exec` prompts. Fall back only for flags scripts don't pass.

| Want             | Use                 | Not                            |
| ---------------- | ------------------- | ------------------------------ |
| Format           | `pnpm format`       | `pnpm exec prettier --write .` |
| Check formatting | `pnpm lint`         | `pnpm exec prettier --check .` |
| Typecheck        | `pnpm check`        | `pnpm exec svelte-check ...`   |
| Unit tests       | `pnpm test`         | `pnpm exec vitest run`         |
| Single test      | `pnpm test <path>`  | `pnpm exec vitest run <path>`  |
| E2E              | `pnpm test:e2e`     | `pnpm exec playwright test`    |
| Full gate        | `pnpm run verify`   | phases by hand                 |
| Dev server       | `pnpm dev:isolated` | `pnpm dev`                     |

Behavior change → add/update tests in the same change, then `pnpm run verify`.

## Browser — Playwright CLI, Firefox

`@playwright/cli` over a browser MCP server (token-efficient). Full commands: `pnpm exec playwright-cli --help`.

```bash
pnpm exec playwright-cli open http://localhost:5193/<page> --browser firefox
pnpm exec playwright-cli snapshot    # a11y snapshot + element refs
pnpm exec playwright-cli click <ref>
pnpm exec playwright-cli screenshot  # eyeball visual changes, tweak, repeat
```

- Standardize on **Firefox**: `--browser firefox` (e2e too). Install: `pnpm exec playwright install firefox`.
- Visual changes: screenshot-iterate, check narrow/wide, light/dark, hover/focus/error.
- Scratch artifacts under `.playwright-cli/` (gitignored).

## Local dev — isolated data dir

Never `pnpm dev` for exploratory work — writes into live `./data` and pollutes the real user's sidebar (`AUTH_MODE=none` = one shared local-dev user).

```bash
pnpm dev:isolated            # fresh tmp DATA_DIR
pnpm dev:isolated --port 5193
```

Live DB inspection: read-only `better-sqlite3` against `./data/portal.db`. Never write via API endpoints.

## Running through this portal

The `InteractiveRequestDialog` UI **is** the approval dialog you trigger.

- **Rejection with no message = user never saw the prompt** (SSE blip, other tab, turn-abort). Check `interactive.resolved` `cancelled: true` or the audit panel's `auto-deny` before assuming a real denial.
- **No prompt timeout.** `DEFAULT_TIMEOUT_MS = 0` (`runtime/interactive-requests.ts`). A hung tool call = user hasn't clicked; not a bug.
- **Auto-approvals are audited.** `auto-allow`/`auto-deny` rows in `permission_decisions`; settings page surfaces them.
- **Portal permission UX ≠ your harness's prompts.** Outside the portal, this repo doesn't affect which calls get auto-approved.
