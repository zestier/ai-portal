# 03 — Backend / SDK integration

This document describes how the SvelteKit server uses
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk) to drive Copilot
agent sessions.

> The exact SDK surface is in public preview and may shift. Treat the type
> names below as illustrative; pin to a known-good version and adapt.

## Provider boundary

The turn runner and pool depend on the provider interfaces in
`$lib/server/copilot/provider.ts`, not on Copilot-specific SDK objects. Copilot
is registered as the default provider via `$lib/server/copilot/providers.ts`;
OpenAI-compatible backends use the same registry behind the
`openai-compatible` provider id.

Provider capabilities are explicit so UI/server code can distinguish core
requirements from Copilot-only enhancements:

| Capability | Required? | Notes |
| ---------- | --------- | ----- |
| Auth status | Yes | `fetchAuthStatus(userId, authToken?)` returns provider-neutral auth state. |
| Model list | Yes | `listModels(userId, authToken?)` returns provider-neutral model metadata. Settings falls back to manual model-id entry when discovery returns no models. |
| Session open | Yes | `openSession(opts)` opens a conversation-scoped backend session. |
| Session resume | Optional | Copilot resumes by `conversationId`; OpenAI-compatible providers may open a fresh backend session and rely on the portal's SQLite transcript. |
| Session dispose | Yes | Idle reaping and conversation deletion must release provider resources. |
| Send stream | Yes | `session.send(prompt, signal)` must yield normalized `PortalEvent` objects. |
| Abort | Yes | Turn cancellation calls `session.abort()` and also aborts the send signal. |
| Mode support | Optional | Copilot supports live `interactive` / `plan` / `autopilot` / `best-effort` mode hints; other providers may ignore `mode` and omit `setMode`. |
| Approve-all support | Optional | Copilot can mirror approve-all into the SDK runtime; other providers may omit `setApproveAll` while the portal still persists the setting. |
| Reset session approvals | Optional | Copilot can clear SDK session-scoped grants; providers without an approval cache omit it. |

`PortalEvent` remains the stream contract consumed by `turn-runner.ts` and the
SSE layer. A provider may translate any native streaming format into that union,
but turn persistence, replay, and frontend rendering must not depend on
provider-native events.

Copilot-only features are modeled as optional provider capabilities:
permission/user-input/elicitation/exit-plan/auto-mode-switch callbacks,
infinite-session metadata, context-window usage and compaction events, file-edit
events, reasoning events, and subagent lifecycle events. OpenAI-compatible
providers currently emit message/tool/error/done events and can add richer
`PortalEvent` variants as their native APIs support them. See
`docs/openai-compatible-backends.md` for operator setup and expected feature
differences.

## Module: `$lib/server/copilot/copilot-provider.ts`

A concrete Copilot provider implementation that:

1. Owns one `CopilotClient` (the SDK's child process) **per portal
   user**, kept in a `Map<userId, CopilotClient>` and started lazily on
   first use. With a multi-entry `ALLOWED_GITHUB_LOGINS` this keeps
   Copilot API calls (billing, audit) attributed to the right GitHub
   identity; in the common single-user deployment there is exactly one
   entry.
2. Opens a per-conversation **session** on top of that user's client,
   scoped to the conversation's working directory.
3. Translates SDK events into the normalized `PortalEvent` discriminated
   union defined in `$lib/types.ts`.
4. Handles backpressure: SSE writes are awaited; if a client disconnects,
   the stream is cancelled and the SDK call aborted via `AbortController`.

### Sketch

```ts
// $lib/server/copilot/copilot-provider.ts
import { CopilotClient } from '@github/copilot-sdk';
import type { PortalEvent } from '$lib/types';

const clients = new Map<string, CopilotClient>();

async function getClient(userId: string, authToken?: string): Promise<CopilotClient> {
  const existing = clients.get(userId);
  if (existing) return existing;
  const client = new CopilotClient({
    useStdio: true,
    autoStart: false,
    useLoggedInUser: true,
    gitHubToken: authToken
  });
  await client.start();
  clients.set(userId, client);
  return client;
}

export interface ProviderOpenOptions {
  conversationId: string;
  userId: string;
  workingDirectory: string;
  model: string;
  policy: PermissionPolicy;
  authToken?: string;
  onEvent?: (e: PortalEvent) => void;
}

export async function open(opts: ProviderOpenOptions): Promise<ProviderSession> {
  const client = await getClient(opts.authToken);
  // … returns a per-conversation Session that wraps client.openSession(…)
  // and exposes send(prompt) -> AsyncIterable<PortalEvent>.
}
```

The SDK event -> `PortalEvent` mapping is isolated in the Copilot provider and
its sibling adapters. It is the single point of coupling to the SDK's wire
format; when the SDK changes, this is the only provider implementation that
needs updating (plus tests).

### Context-window usage events

In addition to the message/tool/permission events documented above, the bridge
also subscribes to the SDK's context-window signals and surfaces them on the
same `PortalEvent` stream:

- `session.usage_info` → `context.usage` — emitted by the SDK once per turn
  (and once with `isInitial: true` at session start) with `currentTokens`,
  `tokenLimit`, `messagesLength`, and an optional `{systemTokens,
  conversationTokens, toolDefinitionsTokens}` breakdown. The turn runner
  persists the latest snapshot to the `conversation_usage` table so that the
  meter can render immediately on page load.
- `session.compaction_start` → `context.compaction` with `phase: 'start'`.
- `session.compaction_complete` → `context.compaction` with `phase: 'complete'`,
  carrying optional `tokensRemoved` / `messagesRemoved`.

Per-call telemetry (`assistant.usage` — input/output/cache/reasoning tokens and
CAPI cost) is intentionally **not** forwarded today; revisit if a per-turn cost
view is needed.

## Module: `$lib/server/copilot/pool.ts`

```ts
// Singleton, per-process. Tracks per-conversation sessions on top of
// the default provider's per-user client pool.
const sessions = new Map<string, { session: ProviderSession; lastUsed: number }>();

export async function acquire(opts: ProviderOpenOptions): Promise<ProviderSession> { ... }
export function touch(convId: string): void { ... }
export async function release(convId: string): Promise<void> { ... }

// Idle reaper, started in hooks.server.ts:
export function startIdleReaper(idleMs: number) {
  setInterval(async () => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      // Never reap a session with work outstanding (an open interactive
      // prompt or an active turn) — see isProtected() below.
      if (now - entry.lastUsed > idleMs && !isProtected(id)) await release(id);
    }
  }, 60_000).unref();
}
```

A session is **protected** from idle reaping / capacity eviction while it has
work outstanding: an open interactive prompt (`interactiveRequests.hasPending`)
or a running turn (the turn registry registers a keep-alive predicate via
`pool.registerKeepAlive`). This stops the "leave a prompt open, come back,
approve, tool never runs" failure where the SDK session backing a parked
`onPermissionRequest` deferred was disposed out from under it. Under capacity
pressure eviction prefers an unprotected session; if every session is busy it
force-evicts the oldest and calls `interactiveRequests.expireConversation`,
which settles the parked deferred with a distinct, non-deny "session expired —
re-issue" outcome (audited `auto-expired`) so the agent unblocks. Forgotten
prompts otherwise pin their session indefinitely — a deliberate trade-off
mirroring `DEFAULT_TIMEOUT_MS = 0` ("a leak is better than a silent deny").

Hard cap: when `clients.size >= MAX_CONCURRENT_SESSIONS`, refuse new sends
with HTTP 429 unless the caller releases an existing one.

## Module: `$lib/server/copilot/interactive-requests.ts`

Generic interactive-request flow (covers permission, auto_mode_switch,
user_input, elicitation, exit_plan_mode, plus informational
sampling / mcp_oauth / external_tool):

1. SDK fires one of `onPermissionRequest` / `onUserInputRequest` /
   `onElicitationRequest` / `onExitPlanMode` / `onAutoModeSwitch`, or
   emits a `sampling.requested` / `mcp.oauth_required` /
   `external_tool.requested` event.
2. Bridge mints a `requestId`, registers a `{ resolve, reject, kind, view }`
   deferred, and emits an `interactive.request` SSE event.
3. Client renders `<InteractiveRequestDialog>` (one component switching on
   `kind`) and the user picks a kind-appropriate response.
4. Client posts `POST /api/conversations/:id/interactive/:requestId` with
   a discriminated `{ kind, ... }` body. Endpoint validates against the
   pending request's kind, resolves the deferred, and returns 200.
5. The registry emits `interactive.resolved` into the turn's event log
   *before* unblocking the SDK so any replay (page refresh) sees the
   resolution and clears the dialog.
6. For `permission` only: "Allow always" persists `{ tool, conversationId }`
   so the bridge can short-circuit future requests for the same tool.

A user-configurable default policy (deny-all / prompt-all / allow-readonly /
allow-all) gates the prompt, but **only** for the `permission` kind —
auto-mode-switch et al. are billing/quota decisions and always ask.

Pending requests have a server-side timeout (default 10 min). When a turn
is aborted, `cancelConversation()` rejects every pending request with a
kind-appropriate default denial so the SDK doesn't hang.

## Conversation turn endpoints

Two endpoints, split so the streaming half is GET-only and usable from
the browser's native `EventSource`:

`POST /api/conversations/[id]/turns` — persists the user message,
snapshots the workdir, calls `startTurn(...)`, and returns
`{ turnId, userMessageId }` synchronously. The turn runs server-side
independent of this request's lifecycle.

`GET /api/conversations/[id]/turns/[turnId]/stream` — opens an SSE
stream for an in-flight (or recently-finished, within the grace window)
turn. Each event carries a monotonic `id:` line:

```
id: 0
data: {"type":"message.start","messageId":"...","role":"assistant"}

id: 1
data: {"type":"message.delta","messageId":"...","text":"hi"}

...

id: N
data: {"type":"done"}
```

On reconnect the browser auto-includes `Last-Event-ID: <n>`; the route
reads the header and calls `turn.subscribe({ sinceId })` so we replay
strictly from `n+1`. Replay events come from the in-memory `eventLog`
that `turn-runner` already maintains.

Returns `410 Gone` if the turn id is unknown — finished turns linger in
the registry for a 60 s grace window, after which the client must
refetch persisted messages via `GET /api/conversations/[id]`.

`DELETE /api/conversations/[id]/turns/[turnId]` — explicit cancel.
Aborts the upstream SDK turn (just closing the EventSource only
detaches the client).

```ts
// stream/+server.ts (sketch)
export const GET: RequestHandler = ({ params, locals, request }) => {
  const conv = authorizeConversation(params.id, locals.userId);
  const turn = getTurnById(conv.id, params.turnId);
  if (!turn) throw error(410, 'Turn no longer available');

  const lastId = request.headers.get('last-event-id');
  const sinceId = lastId !== null ? Number(lastId) : undefined;

  return sseResponse(turn.subscribe({ signal: request.signal, sinceId }), {
    extractId: (item) => item.id,
    extractData: (item) => item.event
  });
};
```

`sseResponse` is a small helper that wraps an async iterable of
JSON-able events into a `Response` with `Content-Type: text/event-stream`
and a 15 s heartbeat. The optional `extractId` / `extractData`
callbacks let id-tagged streams (chat) opt into per-event `id:` lines
while plain streams (redeploy) get the default `data:`-only encoding.

## Auth token plumbing to the SDK

Three modes, in priority order:

1. **Per-user GitHub OAuth token** — minted via the portal's own OAuth app.
   Stored encrypted in SQLite, forwarded to the SDK as `COPILOT_GITHUB_TOKEN`
   for each spawn.
2. **Pre-logged-in `copilot` CLI** — if `~/.config/copilot/auth.json` (or
   equivalent) exists on the host and `AUTH_MODE != github`, the SDK can
   reuse it. Single-user mode.
3. **BYOK** — env vars `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc. forwarded
   to the SDK, with model selection restricted to those providers.

## Testing

- **Unit tests** of the Copilot provider and SDK event adapter against captured
  SDK event fixtures. The single most important set of tests in the project.
- **Bridge integration tests** with a stub Copilot CLI binary (a tiny Node
  script that speaks the SDK's JSON-RPC and emits scripted events). Keeps
  CI fast and offline.
- **End-to-end tests** with Playwright, opt-in (env-gated), against a real
  Copilot subscription. Run nightly, not on every PR.

## Edit-and-rerun (workdir checkpointing)

The SDK does not expose an API to fork a session at an earlier turn, nor
does it snapshot the workdir. Both layers are owned by the portal:

- **Workdir snapshots**: see `docs/persistence.md` — every user turn gets
  a `pre` snapshot, every assistant turn a `post` snapshot, stored as git
  commits under `refs/portal/turns/*` in the conversation's workdir. These are
  restore/diff references, not automatic rollbacks or isolation boundaries.
- **Conversation forking**: editing a user message — or retrying from
  an assistant message — creates a new conversation
  (`src/lib/server/fork.ts`). We spin up a brand-new SDK session keyed
  by the new conversation id rather than trying to mutate the source's
  SDK event log (which we don't own).

### Two fork flavours

The same endpoint (`POST /api/conversations/:id/messages/:msgId/fork`)
covers both:

| Body          | Target role | Snapshot used | Prefix cloned         | New user msg appended |
| ------------- | ----------- | ------------- | --------------------- | --------------------- |
| `{content}`   | `user`      | `pre`         | strictly before target | yes (edited content)¹ |
| `{}`          | `assistant` | `post`        | up to and incl. target | no                    |

"Edit-and-rerun" creates a new transcript from the selected point and lets the
user reword it. "Retry-from-here" creates a new transcript after the selected
assistant turn and lets the user pick up with a different follow-up. Neither
mode rewinds the live files automatically; the snapshot named in the table is a
manual restore/diff reference.

Forking is read-only with respect to the source, so it is allowed even while
the source has a running turn — there is no `source_busy`/`409` rejection.

¹ **Deferred edit-forks:** when the source has a *running* turn, an edit-fork is
created with the prefix only (no trailing user row) and its turn is **not**
auto-started — running a second turn against the shared workdir requires the
user to opt in. The edited text is persisted as the new conversation's
`draft_prompt` (migration `041`) and seeded into the composer on load, so the
user just presses Send. The endpoint response carries `{ deferred: true }` in
this case. While the source is idle the edit-fork still auto-starts as before.

### Discovering forks

A `GET /api/conversations/:id/forks` endpoint lists child forks keyed by
source message id. The chat UI uses this to render a "Forked → …" badge
on each message that has produced a fork. Forked conversations also
expose a parent breadcrumb derived from `forked_from_conversation_id`
on load.

### SDK history seeding

In v1 the forked SDK session starts with **no seeded history**. Prior messages
are cloned into SQLite for UI continuity, but the agent itself has no memory of
them — it picks up cold from the next user prompt, against the current live
workdir unless the user manually restores a snapshot first.

This is a deliberate trade-off:

- It avoids writing into the SDK's `events.jsonl`, whose schema is
  generated and not part of the SDK's public surface.
- It avoids inflating the first prompt with a synthesized preamble that
  would burn context tokens on every fork.
- It avoids implying a transactional rewind. The fork preserves a transcript
  branch and exposes snapshot refs so the user can inspect or manually restore
  file state when that matters.

If/when the SDK exposes a supported way to seed conversation history,
the fork service can opt into it without changing the table schema.
