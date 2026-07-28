# 01 — Architecture

## Components

### 1. SvelteKit app (single deployable unit)

Runs under `@sveltejs/adapter-node`. Serves:

- **Client routes** — chat UI, session list, settings.
- **Server endpoints** (`+server.ts`) — REST-ish JSON API and SSE streams.
- **Hooks** (`hooks.server.ts`) — auth gate, request logging.

A single Node process. No separate API server.

### 2. Model backend provider

A server-side module (`$lib/server/copilot/`) that exposes a provider
interface for model backends. GitHub Copilot is the default implementation via
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk);
OpenAI-compatible backends can be added behind the same provider boundary.
Responsible for:

- Reporting provider auth status and available models.
- Opening/resuming/disposing per-conversation **sessions** on top of the
  selected provider.
- Translating provider-native streams (token deltas, tool calls, permission
  prompts, file edits, context-window usage) into the normalized `PortalEvent`
  stream the turn runner and frontend understand.
- Enforcing per-session resource limits (max concurrent sessions, idle
  timeout).

### 3. Session store (SQLite)

A single `portal.db` file holding:

- Conversations and their messages.
- Tool-call records and approvals.
- Auth state (encrypted refresh tokens, CSRF secrets).
- User settings (default model, default working directory, allowed tools).

See [persistence.md](persistence.md).

### 4. Working directory

Each conversation carries its own persisted `workdir`. New conversations
default to `PROJECT_ROOT`, but can override it; the Copilot SDK, turn
snapshots, and the file/git routes all resolve from that conversation row.
Legacy `DATA_DIR/workspaces/<id>/` paths still fold back to `PROJECT_ROOT`
via `src/lib/server/workdir.ts`.

The `workdir` is a real directory, not a sandbox clone. Conversations that
point at the same path share one filesystem, git repository, package cache,
database files, and long-lived side effects. The portal records per-message
snapshots for inspection, but it does not isolate or transactionally roll back
the working tree per conversation.

Conversations created as **managed worktrees** are the exception: the portal
creates a linked Git worktree and branch at
`WORKTREE_ROOT/<userId>/<conversationId>`, persists ownership metadata, and
uses that path for the provider, tools, actions, snapshots, and file browser.
The path is verified against its generated location and fails closed if it is
missing or replaced; it never falls back to `PROJECT_ROOT`. Managed worktrees
share Git objects and portal snapshot refs with their source repository, but
their checked-out files and index are isolated.

The logical ticket workspace is stored separately from `workdir`. A managed
worktree inherits its source repository's workspace key, so conversations on
different branches still share one ticket backlog.

### 5. Cloudflare Tunnel (optional, deployment-time)

`cloudflared` runs as a sidecar container, exposing the SvelteKit port over
a named tunnel. See [deployment.md](deployment.md).

## Data flow: sending a message

```
User types message in chat UI
        │
        ▼
POST /api/conversations/:id/turns   (JSON body)
        │
        ▼
SvelteKit server endpoint:
  1. Persist user message to SQLite
  2. Snapshot workdir and start an in-memory Turn
  3. Return { turnId } synchronously (no streaming on this response)
        │
        ▼
Client opens EventSource(/api/conversations/:id/turns/:turnId/stream)
  - Each event arrives with an id: line
  - On lock/unlock/network blip the browser auto-reconnects
    with Last-Event-ID, and the server replays from that offset
  - On 410 Gone (turn grace expired) the client refetches messages
        │
        ▼
On turn end (`done` event):
  - Server has already persisted assistant message, tool calls, edits
  - Client closes the EventSource
```

## Streaming protocol

Server → client SSE events, one JSON object per `data:` line:

| `type`                | Payload                                              |
|-----------------------|------------------------------------------------------|
| `message.start`       | `{ messageId, role: "assistant" }`                   |
| `message.delta`       | `{ messageId, text }`                                |
| `message.end`         | `{ messageId }`                                      |
| `tool.call`           | `{ toolCallId, tool, args }`                         |
| `interactive.request` | `{ request: InteractiveRequestView }` (needs ack)    |
| `interactive.resolved`| `{ requestId, kind, outcome }`                       |
| `tool.result`         | `{ toolCallId, ok, summary, output? }`               |
| `file.edit`           | `{ path, diff }`                                     |
| `error`               | `{ code, message }`                                  |
| `done`                | `{}`                                                 |

Interactive acknowledgements (permission, auto-mode-switch, user-input,
elicitation, exit-plan-mode, plus info-only sampling/mcp_oauth/external_tool)
all flow through one endpoint:
`POST /api/conversations/:id/interactive/:requestId` with a
discriminated `{ kind, ... }` body. The legacy
`/permissions/:requestId` endpoint remains as a one-release shim.

## Concurrency model

- **One Copilot provider client per portal user**, lazily started on first use
  and kept by the default provider implementation in `copilot/copilot-provider.ts`. With
  the documented `ALLOWED_GITHUB_LOGINS` allowlist this keeps Copilot API
  attribution (billing, audit) tied to the GitHub identity that actually sent
  the turn instead of whichever user logged in first after process boot. In the
  common single-user deployment there is exactly one entry.
- **One provider session per conversation**, kept alive until idle for N
  minutes (configurable, default 15) or explicitly closed. Held in a
  small in-memory `Map<conversationId, Session>` (`runtime/pool.ts`).
- **Concurrency is scoped by conversation id, not workdir.** The turns API
  rejects a second running turn for the same conversation, but two different
  conversations that reference the same `workdir` can run at the same time and
  interleave filesystem/git side effects. Treat same-workdir conversations like
  separate chat transcripts sharing one keyboard.
- Managed-worktree conversations avoid that filesystem race because each has
  its own checkout. Shared-workdir conversations retain the behavior above.
- Idle reaper runs every minute. On shutdown, all sessions are closed
  and the shared client is stopped cleanly.
- New messages to an idle/closed conversation transparently respawn the
  session and resume from persisted history.

## Failure modes and recovery

- **CLI subprocess crash** — SDK surfaces an error; the bridge marks the
  shared client dead, persists a system message in the conversation, and
  the next user message respawns it.
- **Network error to Copilot backend** — surfaced as a normal `error` event;
  user can retry without losing conversation state.
- **Server restart** — conversations are durable in SQLite. SDK sessions
  and the shared client are ephemeral and recreated on demand. Any
  in-flight assistant turn that was not finalized is marked `interrupted`
  and shown as such in the UI.
