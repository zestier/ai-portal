# Zestier's AI Portal

Zestier's AI Portal (ZAP) is a self-hosted web portal for interacting with
GitHub Copilot's agent runtime, built on top of the official
[`github/copilot-sdk`](https://github.com/github/copilot-sdk). Intended to be run
on a personal/home machine and exposed via a Cloudflare Tunnel (or similar) for
remote access from a phone or laptop.

> **Status:** Phases 0–3 of the roadmap are implemented (single-user
> local chat, tools/permissions/diffs, OAuth + Cloudflare Tunnel
> deployment, plus a read-only git-aware file browser and edit/retry
> forking). The Copilot SDK is pinned to `@github/copilot-sdk@1.0.1`;
> see `package.json`.

## Quick start (local, no auth)

```bash
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY (and SESSION_SECRET if not AUTH_MODE=none).
#   openssl rand -base64 32   # ENCRYPTION_KEY
#   openssl rand -base64 48   # SESSION_SECRET
# For pure-local dev, leave AUTH_MODE=none and set HOST=127.0.0.1 +
# I_KNOW_THIS_IS_LOCAL=1.

# Authenticate the Copilot CLI on the host (the SDK reuses these creds):
#   pnpm dlx @github/copilot auth login

corepack enable        # one-time, to provide pnpm
pnpm install
pnpm run dev   # http://127.0.0.1:5173
```

## Production (Docker + Cloudflare Tunnel)

```bash
docker compose up -d --build
```

See [docs/deployment.md](docs/deployment.md) for the OAuth + tunnel setup.

## Scripts

| Script                               | Purpose                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm run dev`                       | Vite dev server with HMR.                                                          |
| `pnpm run dev:isolated`              | Like `dev`, but points `DATA_DIR` at a fresh temp dir. See [AGENTS.md](AGENTS.md). |
| `pnpm run build`                     | Production build into `build/`.                                                    |
| `pnpm start`                         | Run the production build (`node build`).                                           |
| `pnpm run serve`                     | Supervisor that runs the build from `build.live/` and supports in-app redeploy.    |
| `pnpm run check`                     | `svelte-check` + TS.                                                               |
| `pnpm run lint`                      | ESLint + Prettier check.                                                           |
| `pnpm run format`                    | Prettier write.                                                                    |
| `pnpm test`                          | Vitest unit tests.                                                                 |
| `pnpm run test:e2e`                  | Build + Playwright e2e (uses stubbed Copilot).                                     |
| `pnpm run test:e2e:run`              | Playwright e2e only; expects `build/` to already exist.                            |
| `pnpm run verify`                    | Serial lint/unit/build/check/e2e gate used by redeploy and pre-commit.             |
| `pnpm run verify -- --concurrency 3` | Run the same gate with up to three independent phases in parallel.                 |
| `pnpm run verify:sequential`         | Explicit serial alias for the same verify phases.                                  |
| `pnpm run release:bump-actions`      | Pin GitHub Actions in `.github/workflows/` to current SHAs.                        |

This project uses **pnpm** (declared via `packageManager` in `package.json`).
Use `corepack enable` once to make pnpm available without a global install.

`pnpm install` runs `scripts/install-git-hooks.mjs`, which points `git`
at `scripts/git-hooks/` (containing a `pre-commit` that runs
`pnpm run verify`). To bypass it for an emergency commit:
`SKIP_VERIFY=1 git commit ...`.

`pnpm run verify` preserves the full quality gate: lint, Svelte/TypeScript
check, unit tests, production build, and Playwright e2e. On this workspace
(2026-05-23), the sequential phase baseline was lint 4.8s, check 3.5s,
unit 3.9s, build 3.7s, and Playwright e2e 6.0s for a 22.0s total. The
parallel runner uses a small DAG: lint/unit/build have no dependencies, and
check/e2e depend on build. e2e stays after build because it uses `build/`,
`e2e/.tmp-data`, `playwright-report/`, and `test-results/`, while check is
kept after build so both phases do not write `.svelte-kit` at the same time.
Each child line is prefixed with its phase label so terminal, pre-commit, and
redeploy logs identify failures clearly.

## Goals

- A clean web chat UI for Copilot agent sessions — comparable in feel to the
  VS Code Copilot Chat pane, but accessible from any browser.
- Self-hosted, single-user-first. No cloud middleman.
- Use the **official** GitHub Copilot SDK only. No reverse-engineered endpoints,
  no ToS gray areas.
- Persist conversations locally so sessions survive restarts and can be resumed.
- Trivial to deploy: `docker compose up` + a Cloudflare Tunnel.

## Non-goals (initially)

- Multi-tenant SaaS. Single-user, optionally with a small allowlist of GitHub
  accounts later.
- A Copilot Extensions marketplace / `@agent` registry.
- Full feature parity with VS Code Copilot Chat (no native diff view editor,
  no inline-edit-in-file UX beyond showing the diff produced by the agent).
- Mobile-native apps. Web is responsive; that's enough.

## Caveat: conversations are not independent

Conversations share one host: one filesystem, one git repo, one set of
package-manager caches, one set of long-lived side effects (pushed
branches, deployed services, mutated databases, sent webhooks). The
portal models conversations as if they were independent tabs, but the
substrate underneath them is not. This is not unique to this portal —
Copilot CLI, VS Code Copilot Chat, and similar tools all share the same
limitation — but the portal makes it easier to forget, because you can
fire off a second conversation from your phone while the first is still
running on your laptop.

Treat the portal like a single keyboard:

- Don't run two conversations concurrently against the same repo. Side
  effects will interleave, the working tree will reflect the union of
  both turns, and edit/retry forking will replay onto whatever state
  the _other_ conversation left behind.
- "Allow always" permission grants are scoped to the user, not the
  conversation. A grant approved in one conversation auto-allows the
  same shape in every other conversation.
- Snapshots (`src/lib/server/snapshots.ts`) are forensic, not
  transactional. There is no "roll back what this conversation did."
- If `PROJECT_ROOT` points at this repo, the agent can edit the
  portal's own source while it's running. Vite HMR will pick the edits
  up mid-turn.

If you need real isolation, run separate portal instances with separate
`PROJECT_ROOT`s (and ideally separate `DATA_DIR`s) — e.g. one per repo
you want to work on concurrently.

## Trust model

The portal is designed for a trusted self-hosted operator, not for mutually
distrusting tenants. Anyone allowed to use it should be someone you would trust
with a terminal in the configured `PROJECT_ROOT`: agents can request shell
commands, edit files, mutate git state, and perform external side effects. Use
loopback binding or an authenticating proxy/tunnel as the real access boundary;
inside the portal, permission prompts are confirmation and audit UX, not a
host-sandbox guarantee. See [docs/auth-and-security.md](docs/auth-and-security.md).

## Document index

1. [docs/architecture.md](docs/architecture.md) — Components and data flow.
2. [docs/tech-stack.md](docs/tech-stack.md) — SvelteKit, rationale, dependencies.
3. [docs/backend-sdk-integration.md](docs/backend-sdk-integration.md) — How the
   server uses `@github/copilot-sdk`, session lifecycle, streaming.
4. [docs/frontend-ui.md](docs/frontend-ui.md) — Routes, components, UX details.
5. [docs/auth-and-security.md](docs/auth-and-security.md) — Login, tunnel exposure,
   threat model.
6. [docs/persistence.md](docs/persistence.md) — SQLite schema, conversation storage.
7. [docs/deployment.md](docs/deployment.md) — Dockerfile, compose, Cloudflare Tunnel.
8. [docs/openai-compatible-backends.md](docs/openai-compatible-backends.md) —
   OpenAI-compatible backend setup, settings, and feature differences.
9. [docs/roadmap.md](docs/roadmap.md) — Phases / MVP scope.

See also [CONTRIBUTING.md](CONTRIBUTING.md) for testing, style, and the quality
gate, and [AGENTS.md](AGENTS.md) for agent-specific guidance.

## TL;DR architecture

```
Browser (SvelteKit client)
       │  HTTPS, SSE for streaming
       ▼
SvelteKit server (Node adapter)
       │  @github/copilot-sdk (JSON-RPC over stdio)
       ▼
copilot CLI (server mode, child process)
       │  HTTPS
       ▼
GitHub Copilot backend
```

Persistence (SQLite) lives next to the SvelteKit server. One Copilot CLI
subprocess per active session, managed by the SDK.
