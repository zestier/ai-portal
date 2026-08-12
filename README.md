# Zestier's AI Portal

Zestier's AI Portal (ZAP) is a self-hosted web portal for interacting with an
agentic coding runtime, built on top of the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
SDK. Intended to be run on a personal/home machine and exposed via a
Cloudflare Tunnel (or similar) for remote access from a phone or laptop.

> **Status:** Phases 0–3 of the roadmap are implemented (single-user
> local chat, tools/permissions/diffs, OAuth + Cloudflare Tunnel
> deployment, plus a read-only git-aware file browser and edit/retry
> forking). Sessions are pi SDK sessions against the configured `PI_MODEL`
> (`providerId/modelId`); `PI_STUB=1` swaps in an in-process stub model
> for e2e tests.

## Quick start (local, no auth)

```bash
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY (and SESSION_SECRET if not AUTH_MODE=none).
#   openssl rand -base64 32   # ENCRYPTION_KEY
#   openssl rand -base64 48   # SESSION_SECRET
# For pure-local dev, leave AUTH_MODE=none and set HOST=127.0.0.1 +
# I_KNOW_THIS_IS_LOCAL=1.
#
# Point PI_MODEL at a model id your pi SDK provider can serve, or set
# PI_STUB=1 to run against the in-process stub (no credentials needed).

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
| `pnpm run test:e2e`                  | Build + Playwright e2e (uses the stubbed pi model).                                |
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

- A clean web chat UI for agent sessions — a browser-accessible pane for
  driving the configured agent on the host.
- Self-hosted, single-user-first. No cloud middleman.
- Use the official pi coding-agent SDK only. No reverse-engineered endpoints,
  no ToS gray areas.
- Persist conversations locally so sessions survive restarts and can be resumed.
- Trivial to deploy: `docker compose up` + a Cloudflare Tunnel.

## Non-goals (initially)

- Multi-tenant SaaS. Single-user, optionally with a small allowlist of GitHub
  accounts later.
- An extensions marketplace / `@agent` registry.
- Full feature parity with a desktop chat pane (no native diff view editor,
  no inline-edit-in-file UX beyond showing the diff produced by the agent).
- Mobile-native apps. Web is responsive; that's enough.

## Caveat: conversations are not independent

Conversations share one host: one filesystem, one git repo, one set of
package-manager caches, one set of long-lived side effects (pushed
branches, deployed services, mutated databases, sent webhooks). The
portal models conversations as if they were independent tabs, but the
substrate underneath them is not. This is not unique to this portal —
any CLI agent runtime shares the same limitation — but the portal makes
it easier to forget, because you can fire off a second conversation from
your phone while the first is still running on your laptop.

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
3. [docs/frontend-ui.md](docs/frontend-ui.md) — Routes, components, UX details.
4. [docs/auth-and-security.md](docs/auth-and-security.md) — Login, tunnel exposure,
   threat model.
5. [docs/persistence.md](docs/persistence.md) — SQLite schema, conversation storage.
6. [docs/deployment.md](docs/deployment.md) — Dockerfile, compose, Cloudflare Tunnel.
7. [docs/roadmap.md](docs/roadmap.md) — Phases / MVP scope.
8. [docs/memory-backed-sessions.md](docs/memory-backed-sessions.md) — Persistent memory
   and the memory extractor.

See also [CONTRIBUTING.md](CONTRIBUTING.md) for testing, style, and the quality
gate, and [AGENTS.md](AGENTS.md) for agent-specific guidance.

## TL;DR architecture

```
Browser (SvelteKit client)
       │  HTTPS, SSE for streaming
       ▼
SvelteKit server (Node adapter)
       │  @earendil-works/pi-coding-agent (session per conversation)
       ▼
pi agent runtime — model resolved from PI_MODEL (providerId/modelId),
or the in-process stub model when PI_STUB=1
```

Persistence (SQLite) lives next to the SvelteKit server. Sessions are held
in `src/lib/server/runtime/pool.ts` and reaped after an idle timeout.
