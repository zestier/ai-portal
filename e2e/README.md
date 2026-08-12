# Playwright e2e tests

End-to-end tests for the portal, run against the production build with an
isolated SQLite database and a **stubbed** pi model (`PI_STUB=1`) so no real
model credentials or network are required.

## Run locally

```bash
pnpm test:e2e
```

The E2E command installs the configured Firefox browser and its Linux system
dependencies, so `pnpm run verify` works from a fresh dependency install.

The `webServer` in `playwright.config.ts` builds the app and launches
`node build` on port 4173 against `e2e/.tmp-data/` (wiped on each run).
Specs use unique conversations and per-test workdirs so Playwright can run
them with multiple workers. Set `E2E_WORKERS=1` to force serial execution.

Set `E2E_ISOLATED=1` to refuse to reuse/attach to any already-running server
(forcing a fresh, throwaway server on the e2e port). The in-app redeploy uses
this so it can run the full gate while the live portal is still serving without
risk of Playwright driving the live server or its DB.

## Stub mode

When the server starts with `PI_STUB=1`, `src/lib/server/pi/session.ts`
registers an in-process OpenAI-compatible stub model (`stub-server.ts`) into the
pi runtime instead of loading a real model. The pi SDK drives the stub over
real HTTP, and the model replies with a streamed `"Stubbed reply to: <last user
message>"`. The full turn-runner, SSE, and persistence paths are exercised
normally.
