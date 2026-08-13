# 08 — Roadmap

Phased plan. Each phase ends in a usable artifact.

## Completed

- **Backend-projected transcript (BFF presentation layer)** — long
  conversations open fast on phones. The page payload is a bounded hydrated
  tail + an index of older messages with server-computed summaries
  (`src/lib/server/present/transcript.ts`); the client renders only a
  viewport window of full cards (index rows elsewhere), hydrates bodies on
  demand (`/messages/[messageId]`), pages older history
  (`/messages?beforeId=`), and replaces whole-transcript Ctrl+F with an FTS
  search box + `?message=` permalinks. File-edit diffs are lazy sections.
  Bench targets: ≤ ~40 KB initial payload, ≤ 40 mounted cards, TTI ≤ ~200 ms.

## Phase 0 — Scaffolding (½ day)
  Playwright.
- Add `@sveltejs/adapter-node`, `better-sqlite3`, `zod`,
  `@earendil-works/pi-coding-agent`.
- Drop in `Dockerfile`, `compose.yaml`, `.env.example`.
- CI: GitHub Actions running `npm run lint && npm run check && npm test`
  and building the Docker image (no push).

**Exit criteria:** `docker compose up` serves a "hello" page on `:3000`.

## Phase 1 — Single-user local chat (MVP)

- `AUTH_MODE=none` (localhost-only, gated by `I_KNOW_THIS_IS_LOCAL=1`).
- SQLite + initial migration (`users`, `conversations`, `messages`).
- Auto-create a single local user on first run.
- Session module opening pi sessions against the configured `PI_MODEL`
  (a `providerId/modelId` id on the process-wide model runtime).
- Conversation create + send + SSE stream + assistant render.
- Sidebar with conversation list, rename, delete.
- Markdown rendering with code blocks (no syntax highlighting yet).

## Phase 2.5 — Read-only file browser

- Hierarchical git-aware file browser scoped to a conversation's workdir.
- Per-entry status badges, branch/HEAD + ahead/behind, recent commit log
  with per-file diffs.
- Surfaced as a **Files** tab on the conversation page; chat unchanged.

**Exit criteria:** I can have a multi-turn conversation with the agent from
a browser tab on my laptop, persistent across restarts.

## Phase 2 — Tools, permissions, diffs

- Tool-call rendering (folded cards with status).
- Permission prompt flow (Allow once / Allow always / Deny) wired to the
  SDK's permission hook.
- File-edit diff rendering.
- Default policy setting in `/settings`.
- Persist tool calls, file edits, permission decisions.

**Exit criteria:** I can let the agent edit files in a sandboxed working dir
with explicit approval, and review the diffs in the UI.

## Phase 3 — Remote-safe auth and deploy

- GitHub OAuth flow + `ALLOWED_GITHUB_LOGINS`.
- Session cookie + CSRF + CSP.
- Encrypted token storage.
- Cloudflare Tunnel docs verified end-to-end.

**Exit criteria:** I can expose the portal at
`zap.example.com` behind CF Access and use it from my phone safely.

## Phase 4 — Quality of life

- Syntax highlighting for code blocks (lazy-loaded highlighter; library TBD).
- Composer drag-and-drop file context.
- Per-conversation working-directory display + open-in-editor hint.
- Export (markdown per conversation, tarball whole-DB).
- Model picker per conversation (lists models reported by SDK).
- Mobile polish pass.

## Phase 5 — Extensibility

- Custom agents / skills via the SDK's hook points, surfaced as a settings
  UI.
- MCP server registration (the SDK supports MCP; expose a config UI).

## Out of scope (for now, maybe ever)

- Multi-tenant hosting / SaaS.
- Mobile-native clients.
- In-browser editor with live file tree (we render diffs, not a full IDE).
- Voice input.

## Open questions / decisions to revisit

1. **Session resumption semantics.** When the SDK client is reaped after
   idle, does sending a new prompt fully restore the agent's working memory
   from persisted messages, or does the SDK have a first-class "load
   conversation" API? Behavior may differ across SDK versions; verify
   against the version we pin.
2. **Long-running tools.** Some tool calls (test runs, builds) can run
   minutes. SSE is fine but HTTP/1.1 proxies sometimes idle-time out;
   confirm Cloudflare Tunnel's default streaming timeout (currently 100 s
   for HTTP, configurable). Heartbeat events every 15 s on the SSE stream.
3. **Workspace strategy.** Do we ever want to let a conversation operate
   against a *bare-cloned* repo we manage, vs. a directory the user
   provides? See the "Caveat: conversations are not independent" section
   in the README — today every conversation defaults to `PROJECT_ROOT`
   and shares one working tree, which is the underlying reason this
   question matters. A managed-clone-per-conversation model would
   address it but is non-trivial (worktrees only solve part of the
   problem; package caches, ports, external side effects still leak).
   Probably phase 4+.
4. **Telemetry.** None planned. Confirm the SDK doesn't phone home for
   anything beyond what the user expects from the agent itself.
