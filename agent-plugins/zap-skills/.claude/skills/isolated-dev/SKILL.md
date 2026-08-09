---
name: isolated-dev
description: Run exploratory work against `pnpm dev:isolated` (fresh tmp DATA_DIR) instead of `pnpm dev` on the default `./data`, which pollutes the live local user's DB with scratch conversations.
---

# Isolated dev server

Never run `pnpm dev` against the default `./data` when doing exploratory work
(Playwright probes, curl-driven API testing, scratch conversations, etc.). The
portal's `AUTH_MODE=none` fallback creates a single shared "local-dev" user, so
any conversations/messages a test creates land in the same sidebar the human
user sees in their real session — polluting the live DB with junk.

Use the isolated dev server instead:

```
pnpm dev:isolated
pnpm dev:isolated --port 5193
```

The script (`scripts/dev-isolated.mjs`) points `DATA_DIR` at a fresh temp
directory, sets `AUTH_MODE=none` with the required local-only guards, and
provides throwaway secrets. Real user data is untouched.

## Inspecting the live DB read-only

If you genuinely need to inspect the live DB, do it read-only via
`better-sqlite3` against `./data/portal.db` — don't write through API endpoints,
which mutate state under the live local user.
