# 02 — Tech stack

## Why SvelteKit

- One repo, one process, one deploy. SSR + server endpoints + static assets
  from the same toolchain.
- The pi coding-agent SDK is Node-native; SvelteKit's Node adapter lets us
  call it directly from `+server.ts` without a separate API tier.
- Svelte 5 runes (`$state`, `$derived`) map cleanly onto streaming chat state.
- Small client bundle — important for a tool that may be loaded over a slow
  tunnel from a phone.

(React + Next would also work; the design here doesn't depend on Svelte
specifics beyond file conventions.)

## Runtime

- **Node.js ≥ 24** (declared in `engines`; we use a few `node:` builtins that
  are only stable on 22+).
- **TypeScript** everywhere. `strict: true`.
- **`@sveltejs/adapter-node`** for production build.

## Core dependencies

| Purpose                  | Package                                            |
|--------------------------|----------------------------------------------------|
| Web framework            | `@sveltejs/kit`, `svelte` (v5)                     |
| Agent integration        | `@earendil-works/pi-coding-agent`                  |
| DB                       | `better-sqlite3` (sync, fast, embedded)            |
| Migrations               | Hand-rolled in `src/lib/server/db/migrations/`     |
| Schema/validation        | `zod`                                              |
| Markdown rendering       | `marked` + `dompurify` (sanitize on client)        |
| Diff rendering           | `diff` + custom Svelte component                   |
| Request hardening        | Same-origin + CSRF double-submit (no auth layer)   |
| Crypto for at-rest       | Node `crypto` (AES-256-GCM)                        |
| ID generation            | `ulid` (monotonic factory)                         |
| Testing (unit)           | `vitest`                                           |
| Testing (e2e)            | `@playwright/test`                                 |
| Lint/format              | `eslint`, `prettier`, `svelte-check`               |

No global state managers (Pinia/Redux-equivalent). Svelte 5 runes plus
a few small `.svelte.ts`/`.ts` modules under `src/lib/client/` are enough.

## Repository layout

```
zap/
├─ src/
│  ├─ app.html
│  ├─ app.d.ts
│  ├─ hooks.server.ts
│  ├─ lib/
│  │  ├─ client/                  # browser-only helpers
│  │  │  ├─ sse.ts
│  │  │  ├─ markdown.ts
│  │  │  ├─ diff-parser.ts
│  │  │  ├─ file-browser.ts
│  │  │  ├─ interactive-queue.ts
│  │  │  └─ sidebar.ts
│  │  ├─ components/             # Chat, Sidebar, FileBrowser,
│  │  │                          # InteractiveRequestDialog, ToolCall,
│  │  │                          # DiffView, ContextMeter,
│  │  │                          # ReasoningBlock, … + ui/
│  │  ├─ server/
│  │  │  ├─ pi/                    # pi coding-agent SDK integration
│  │  │  │  ├─ index.ts            # openPiSession, model runtime
│  │  │  │  ├─ session.ts          # SDK session wrapper
│  │  │  │  ├─ session-contract.ts # Provider* session types
│  │  │  │  ├─ events.ts           # event normalization
│  │  │  │  └─ stub-server.ts      # in-process stub (e2e via PI_STUB)
│  │  │  ├─ runtime/
│  │  │  │  ├─ pool.ts             # conversation→session map, idle reaper
│  │  │  │  ├─ turn-runner.ts      # per-turn event log + persistence
│  │  │  │  ├─ async-queue.ts
│  │  │  │  └─ interactive-requests.ts
│  │  │  ├─ db/
│  │  │  │  ├─ index.ts           # better-sqlite3 singleton
│  │  │  │  ├─ ids.ts             # monotonic ULID factory
│  │  │  │  ├─ migrations/
│  │  │  │  └─ repos/             # conversations, messages, settings,
│  │  │  │                       # tokens, usage, users
│  │  │  ├─ csrf.ts             # CSRF double-submit helpers
│  │  │  ├─ files.ts            # FS read / tree (workspace-rooted)
│  │  │  ├─ git.ts              # git plumbing (status, log, diff)
│  │  │  ├─ snapshots.ts        # per-turn pre/post git snapshots
│  │  │  ├─ fork.ts             # edit-and-rerun / retry forks
│  │  │  ├─ workdir.ts          # PROJECT_ROOT resolution
│  │  │  ├─ conversation-auth.ts
│  │  │  ├─ http.ts             # JSON response envelopes
│  │  │  ├─ sse.ts              # SSE response helper
│  │  │  ├─ crypto.ts           # AES-256-GCM
│  │  │  ├─ title.ts            # auto-title via the SDK
│  │  │  ├─ validate.ts
│  │  │  ├─ log.ts
│  │  │  └─ config.ts           # env parsing via zod
│  │  └─ types.ts
│  └─ routes/
│     ├─ +layout.svelte
│     ├─ +layout.server.ts        # user info / sidebar data
│     ├─ +page.svelte             # conversation list / new chat
│     ├─ conversations/[id]/      # chat view
│     ├─ settings/
│     └─ api/
│        ├─ admin/                # redeploy
│        ├─ conversations/
│        │  ├─ +server.ts                            # POST create, GET list
│        │  └─ [id]/
│        │     ├─ +server.ts                         # GET, DELETE
│        │     ├─ export/                            # markdown export
│        │     ├─ forks/                             # list child forks
│        │     ├─ fs/                                # tree, file, diff
│        │     ├─ git/                               # status, log, commit
│        │     ├─ messages/[msgId]/fork/             # edit / retry
│        │     ├─ permissions/[requestId]/+server.ts
│        │     └─ turns/
│        │        ├─ +server.ts                       # POST start turn
│        │        └─ [turnId]/stream/+server.ts       # GET SSE, DELETE cancel
│        └─ health/+server.ts
├─ static/
├─ scripts/
│  ├─ serve.mjs                # supervisor with build.live/ swap
│  ├─ dev-isolated.mjs         # dev with throwaway DATA_DIR
│  ├─ install-git-hooks.mjs
│  └─ git-hooks/pre-commit
├─ e2e/                        # Playwright specs
├─ tests/                      # vitest unit specs
├─ Dockerfile
├─ compose.yaml
├─ package.json
├─ svelte.config.js
├─ vite.config.ts
└─ tsconfig.json
```

## Configuration (env)

All env vars validated with `zod` at startup; the process refuses to start on
invalid config.

| Var                       | Default                  | Description                          |
|---------------------------|--------------------------|--------------------------------------|
| `PORT`                    | `3000`                   | Listen port.                         |
| `HOST`                    | `127.0.0.1`              | Listen address.                      |
| `DATA_DIR`                | `./data`                 | DB root (`portal.db` + legacy workspaces dir). |
| `PROJECT_ROOT`            | *(process cwd)*          | The directory the pi agent and the FS/git tabs operate inside. Shared by all conversations. |
| `ENCRYPTION_KEY`          | *(required, base64 of 32 raw bytes)* | At-rest encryption for provider/BYOK API keys. |
| `I_KNOW_THIS_IS_LOCAL`    | —                        | Must be `1` for `HOST=127.0.0.1` (loopback is the safe default — the app has no auth). |
| `I_KNOW_THIS_IS_NETWORK_ACCESSIBLE` | —             | Must be `1` for `HOST=0.0.0.0`. Stronger assertion, stands alone; only for a fenced reachability boundary (private network / Tailscale / no published port). |
| `DEFAULT_MODEL`           | `claude-sonnet-4.5`      | Default model id for new conversations (a pi model id, `providerId/modelId`). |
| `PI_MODEL`                | `anthropic/claude-sonnet-4-5` | Pi model id (`providerId/modelId`) for the pi path, used when `PI_STUB` is unset. |
| `PI_STUB`                 | —                        | Set to `1` to run the pi path against the in-process stub model. Used by e2e tests. |
| `MEMORY_EXTRACTOR_BACKEND` | `heuristic`             | Server-wide default for harvesting durable memories from conversations: a pi model selection (`providerId/modelId`, e.g. `anthropic/claude-sonnet-4-5`) resolved against the configured pi providers, or `heuristic` (local, no network). A model-backed selection runs a dedicated tool-calling background agent that stores memory by calling the memory tools, with per-call validation feedback; its work surfaces as a subagent card. A per-conversation override (chat header) wins; an unset conversation column resolves to this env value. An unresolvable selection falls back to the heuristic extractor for that turn. |
| `MEMORY_EXTRACTOR_TIMEOUT_MS` | `20000`              | Request timeout (ms) for each model-backed extraction request. |
| `MEMORY_EXTRACTOR_MAX_INPUT_CHARS` | `12000`         | Cap on conversation text sent to the model extractor. |
| `MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS` | `6`         | Max tool-calling iterations for the `openai-compatible-tools` extractor before it stops and commits whatever it staged. |
| `MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS` | `60000`        | Overall wall-clock budget (ms) for the `openai-compatible-tools` extractor loop. Bounds the whole loop rather than a single request, so it can't hold the turn open for `MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS` × `MEMORY_EXTRACTOR_TIMEOUT_MS` in the worst case. |
| `MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS` | `15000`      | Grace added to the extractor wall-clock budget before the turn-runner watchdog force-finalizes the post-turn extraction phase (ceiling = wallclock + grace). Bounds only the extraction phase — even a provider that ignores fetch abort can't wedge the turn in `running`; the main agent turn stays unbounded. |
| `ADVERSARY_SHADOW_BACKEND` | —                       | **Experimental, off by default.** Server-wide default reviewer for the Phase 0 adversarial approval shadow: a pi model selection (`providerId/modelId`, e.g. `anthropic/claude-sonnet-4-5`) resolved against the configured pi providers. A second model records what it *would* have decided about each permission request, next to what the human clicked, with no authority over the outcome. Setting a selection is what enables it — there is no separate on/off flag. A per-conversation value (chat header) wins; clearing that value falls back here. Skipped when it matches the conversation's own model selection. Read the results with `pnpm run report:adversary-shadow`. |
| `ADVERSARY_SHADOW_TIMEOUT_MS` | `20000`              | Request timeout (ms) for each reviewer call, covering the body read as well as the headers. |
| `ADVERSARY_SHADOW_MAX_ARG_CHARS` | `4000`            | Cap on agent-authored tool arguments included in the reviewer prompt (and therefore on the copy stored for later adjudication). |
| `ADVERSARY_SHADOW_MAX_IN_FLIGHT` | `4`               | Ceiling on simultaneous reviewer calls. Matters most in `auto-approve` conversations, where no dialog paces the requests; over-cap requests are recorded as explicit skips rather than dropped, so the gap stays visible in the readout. |
| `IDLE_TIMEOUT_MIN`        | `15`                     | SDK session idle reap.               |
| `MAX_CONCURRENT_SESSIONS` | `4`                      | Hard cap on live sessions.           |
| `TURN_ABORT_FINALIZE_DEADLINE_MS` | `5000`           | After a user Stop, the turn must reach a terminal state and free the conversation within this deadline even if post-turn memory extraction hasn't unwound; the stuck extraction is abandoned past this point. |
| `LOG_LEVEL`               | `info`                   | `debug` \| `info` \| `warn` \| `error`. |
| `ENABLE_REDEPLOY`         | —                        | Set to `1` to enable `POST /api/admin/redeploy` (only meaningful under `pnpm run serve`). |
| `DB_MIGRATIONS_DIR`       | *(auto)*                 | Explicit override for the migrations directory. Useful when cwd isn't the repo root. |
