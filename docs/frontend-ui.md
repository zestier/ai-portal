# 04 — Frontend / UI

Svelte 5, SvelteKit file-based routing. Mobile-first responsive layout.

## Routes

| Path                         | Purpose                                                |
|------------------------------|--------------------------------------------------------|
| `/`                          | Conversation list + "New chat" CTA.                    |
| `/conversations/[id]`        | Chat view for a single conversation.                   |
| `/settings`                  | User settings, provider status, model defaults, default workdir, etc. |
| `/login`                     | OAuth entry point.                                     |
| `/auth/callback`             | OAuth callback target.                                 |

All routes except `/login` and `/auth/callback` require an authenticated
session (enforced in `hooks.server.ts`).

## Layout

```
┌──────────────────────────────────────────────────────┐
│  Sidebar (collapsible on mobile)   │   Main          │
│  ┌────────────────────────────┐    │   ┌──────────┐  │
│  │ New shared/worktree chat   │    │   │ Header   │  │
│  │ ── Conversations ──        │    │   │  title,  │  │
│  │  • "Fix flaky test in foo" │    │   │  model,  │  │
│  │  • "Draft release notes"   │    │   │  workdir │  │
│  │  • …                       │    │   └──────────┘  │
│  │                            │    │   ┌──────────┐  │
│  │ ── Settings                │    │   │ Messages │  │
│  └────────────────────────────┘    │   │  scroll  │  │
│                                    │   └──────────┘  │
│                                    │   ┌──────────┐  │
│                                    │   │ Composer │  │
│                                    │   └──────────┘  │
└──────────────────────────────────────────────────────┘
```

Sidebar is a `<details>`-like drawer below a breakpoint (~768 px).

## Components

### `Chat.svelte`

Owns the conversation's runtime state: messages, current stream, pending
interactive requests. Reads initial data from `+page.server.ts`'s `load`,
then opens an SSE connection on submit.

State (Svelte 5 runes):

```ts
let messages = $state<Message[]>(initial);
let streaming = $state<{ messageId: string; buffer: string } | null>(null);
let pendingInteractive = $state<InteractiveRequestView[]>([]);
let toolCalls = $state<Record<string, ToolCallView>>({});
```

#### Backend-projected transcript (windowed + lazy)

Long conversations ship as a **projection**, not raw rows
(`src/lib/server/present/transcript.ts`): the page `load` and
`GET /api/conversations/[id]` return a bounded hydrated tail (records
trimmed to markers, with server-computed summaries) plus an index of older
messages carrying plain-text previews and per-record descriptors. The client
store (`src/lib/client/transcript-store.ts`) keeps `entries` (all messages
in order) and `bodies` (hydrated `DisplayMessage`s, LRU-capped), so the
initial payload is bounded regardless of conversation length and the client
never derives collapsed summaries from raw args.

- **Windowed rendering**: only a viewport ± margin window (≤ 40 messages)
  mounts full `Message_` cards; everything else renders as a compact
  `MessageIndexRow` (preview + record summary chips) that keeps the
  scrollbar honest. The window is recomputed from real row offsets on
  scroll, so it can't drift even when cards change height mid-stream.
- **Hydration**: index rows near the viewport fetch their full body from
  `GET /api/conversations/[id]/messages/[messageId]` during idle, in small
  serialized batches (no fetch storms); bodies are LRU-evicted
  (≤ 100) and demote back to index rows. Expanding a trimmed field still
  fetches it via `/api/conversations/[id]/fields/[kind]/[recordId]`.
- **Load older**: scrolling to the top fetches the next index-only page
  (`GET /api/conversations/[id]/messages?beforeId=&limit=`), anchoring the
  viewport via the existing `distanceFromBottom` guard.
- **Search + permalinks**: an in-app search box (wired to the FTS
  `searchConversation`) jumps to a hit, hydrating the window around it;
  `?message=<id>` deep-links scroll to and highlight a message.
- **File-edit diffs** render collapsed to path + diffstat and hydrate the
  full diff on expand (`DiffView` `collapsedByDefault`).
- **Refresh semantics**: refresh merges the server's tail into the store
  and keeps hydrated older pages (messages are immutable); inline
  edit/regenerate truncate the cache past the cut before the replacement
  turn streams in.

### `Message.svelte`

Renders one message. Assistant content is markdown → sanitized HTML
(`marked` → `DOMPurify`, client-side). Code blocks render as plain
`<pre><code>` with copy buttons. Tool calls and file edits are rendered as
folded inline cards.

### `ToolCall.svelte`

Folded card showing tool name, status (pending/running/ok/error), and
expanding to show arguments and result/output.

### `DiffView.svelte`

Renders unified diff with side-by-side or inline toggle. Code lines are
syntax-highlighted with a lazy `highlight.js` core bundle plus an explicit
language allow-list; add/remove/context backgrounds, gutters, comment
affordances, and diff signs remain the diff semantics. Per-edit "open in
editor" link is just informational on the web build; on desktop, clicking the
path copies it to clipboard.

### `FileBrowser.svelte`

Read-only, git-aware file browser rooted at the selected conversation's
persisted `workdir` (resolved to its realpath on the server). New conversations
default to `PROJECT_ROOT`, so most conversations in a deployment browse the
same live tree unless the user explicitly chooses different workdirs. The
conversation id in the API URL is used for ownership/auth and to pick that
workdir; it does not create a private filesystem. Surfaced as three top-level
tabs on `/conversations/[id]` — **Changes**, **Files**, **Commits** — sitting
alongside **Chat**. The component is driven by a `pane` prop (one of those
three values) and shares a two-pane layout: a left rail whose
contents depend on the active tab (changed-file list, hierarchical file
tree with per-entry git status badges and roll-ups plus hidden/ignored
toggles, or recent commit log with branch / ahead-behind header and "Load
more"), and a right pane that renders either the selected file (text
content + binary placeholder, capped at 1 MiB) with a **Content** /
**Diff** toggle, or a selected commit's detail with its file list and
per-file diff. The shared `GitStatusHeader` sits above the left rail on
all three tabs. Mobile collapses both grids into stacked single-pane rows.
Text file content and the Changes/Commits diff surfaces use the shared
`src/lib/client/syntax-highlight.ts` helper, which detects languages from file
extensions, lazy-loads only the requested `highlight.js` language module, escapes
all fallback text, and skips highlighting above the configured size caps to keep
large files responsive.

Backed by:

| Endpoint                                              | Returns                       |
| ----------------------------------------------------- | ----------------------------- |
| `GET /api/conversations/[id]/fs/tree?path=&hidden=&ignored=` | Directory listing + git status per entry. |
| `GET /api/conversations/[id]/fs/file?path=&ref=`     | File content (working tree or git revision); binary detected. |
| `GET /api/conversations/[id]/fs/diff?target=&sha=&path=` | Unified diff (working tree vs HEAD/index, or commit). |
| `GET /api/conversations/[id]/git/status`             | Branch, HEAD sha, upstream, ahead/behind, dirty count. |
| `GET /api/conversations/[id]/git/log?limit=&skip=`   | Recent commits.               |
| `GET /api/conversations/[id]/git/commit/[commitSha]`       | Commit metadata + changed files. |

All paths are constrained to the workspace root realpath; symlinks that
escape are rejected. `git` is spawned with `shell: false`, hard timeouts,
and output size caps.

#### Code review comments

The right pane is _commentable_: hovering any line in the file content view,
a change diff, or a commit diff reveals a `+` affordance that opens an inline
feedback box for that exact line. Saved comments accumulate in a review drawer
at the bottom of the pane (grouped, removable, with a count). **Send to chat**
assembles them into a Markdown review message, drops it into the chat
composer, and switches back to the Chat tab so the user can edit and send it
to the agent — the human-review counterpart to the agent's own edits.

The draft review lives in a conversation-scoped module store
(`src/lib/client/review.svelte.ts`) rather than component state, because the
`FileBrowser` and `Chat` components mount/unmount as the user switches tabs;
the store survives the switch and is the hand-off channel to the composer.
The Markdown assembly is a pure, unit-tested helper
(`src/lib/client/review-format.ts`). `DiffView.svelte` exposes opt-in
`commentable` / `onLineClick` / `commentedKeys` props; its other call sites
(chat messages, tool results) leave them off and are unchanged.


### `ui/Modal.svelte`

The shared overlay primitive. Wraps a native `<dialog>` driven by an `open`
prop, so the platform provides the focus trap, inert background, and Escape
handling; the component adds backdrop-click dismissal (`onClose`), body
scroll-lock while open, and the consistent panel chrome (surface, `--border`,
`--radius-lg`, `--shadow-2`). The dim comes from `::backdrop` using the shared
`--overlay` token, and the dialog sits on the `--z-modal` layer. `width` /
`maxHeight` / `panelClass` tune the panel; `labelledby` / `ariaLabel` / `role`
wire up accessibility. All true modal dialogs (`RawInputDialog`, the
`PromptTemplateLauncher` picker) render through this — no component should
hand-roll its own backdrop or pick a raw z-index.

`InteractiveRequestDialog` is deliberately **not** a Modal: it is an inline
transcript card (see below), not a page-blocking overlay.

### `InteractiveRequestDialog.svelte`

Inline transcript card (not a backdrop modal) that handles every interactive-request kind the
agent runtime can ask for: tool permission (Allow once / Allow always /
Deny), auto-mode-switch on rate limit, user_input (choices + freeform),
elicitation (schema-driven form or url mode), and informational sampling /
mcp_oauth / external_tool surfaces.
Switches on `request.kind` and posts an `InteractiveResponse` to
`POST /api/conversations/:id/interactive/:requestId`.

### `Composer.svelte`

Textarea with autosize. Submit on `Cmd/Ctrl+Enter`. Plain `Enter` inserts a
newline. Drag-and-drop file attachment (phase 2) reads file contents and
includes them inline in the prompt.

### `Sidebar.svelte`

Conversation list with relative timestamps. Each row has a kebab (⋯) menu
exposing **Rename** (inline edit), **Archive**/**Unarchive**, and **Delete**.
Archived conversations are tucked into a collapsible "Archived (N)" group.
A **Select** button enables multi-select mode with a bulk action bar at the
bottom for archiving, unarchiving, or deleting in batches. API failures
surface in a dismissible inline banner. Click a row to navigate; archiving
releases the conversation's pooled SDK client.

The launcher offers shared and managed-worktree chats. Managed conversations
show their branch and base commit in the chat header. Deleting a dirty managed
worktree produces a second destructive confirmation; declining leaves both the
conversation and files intact. Message actions also offer an opt-in worktree
fork that restores the selected turn snapshot into a new linked checkout.

## Streaming on the client

Chat streaming uses the browser's native `EventSource`. The architecture
splits "start a turn" (POST) from "stream a turn" (GET-only SSE) so we
can hand the entire reconnect lifecycle — including `Last-Event-ID`
replay on auto-reconnect — to the browser.

```ts
async function send(text: string) {
  const r = await fetch(`/api/conversations/${id}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text })
  });
  const { turnId } = await r.json();
  const es = new EventSource(`/api/conversations/${id}/turns/${turnId}/stream`);
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data) as PortalEvent;
    applyEvent(ev);
    if (ev.type === 'done') es.close();
  };
  // `sseResponse`'s defensive error frame is a *named* `stream_error` event,
  // which native EventSource routes away from `onmessage`. Forward it through
  // the same handler so the in-band error surfacing still fires.
  es.addEventListener('stream_error', (msg) => es.onmessage?.(msg as MessageEvent));
  es.onerror = () => {
    // Transient errors keep readyState === CONNECTING and the browser
    // auto-reconnects. Only CLOSED is terminal (e.g. server 410 Gone
    // after the finished-turn grace expired during a phone lock).
    if (es.readyState === EventSource.CLOSED) {
      void refreshMessages(); // re-pull persisted state so UI catches up
    }
  };
}
```

Each event the server emits carries a monotonic `id:` line; on
auto-reconnect the browser sends `Last-Event-ID` and the server replays
strictly from there. No client-side stall watchdog, no manual backoff,
no `visibilitychange`/`online` choreography — locking and unlocking the
phone mid-turn just works.

A visible "Stop" button issues `DELETE /api/conversations/[id]/turns/[turnId]`
to actually cancel the upstream SDK turn (closing the EventSource alone
would only detach this client).

## Context-window meter

The chat header renders a `ContextMeter` next to the conversation title showing
`currentTokens / tokenLimit` plus a percentage. The bar fill is color-coded by
threshold: green below 70%, amber 70–90%, red above 90%. The meter is a simple
bar — no per-category breakdown (pi exposes only tokens / context window /
percent, so there is nothing richer to show).

Data flow:

- Initial value comes from `+page.server.ts`, which reads the latest snapshot
  from the `conversation_usage` table and passes it to `Chat.svelte` as
  `initialUsage`, so the meter survives reloads.
- Live updates arrive on the SSE stream as `context.usage` events: once per
  turn, the pi session calls `AgentSession.getContextUsage()` at `agent_end`
  and maps the result (`currentTokens = tokens`, `tokenLimit = contextWindow`,
  `percentage = percent`) through `piContextUsageToEvent` before the turn
  stream closes. When `tokens` is unknown (e.g. right after compaction) the
  snapshot is skipped and the meter keeps its last value.
- No live compaction notice: pi auto-compacts in post-run processing *after*
  the portal turn stream closes, so a `compaction_end` signal can't reach the
  client without changing turn-done timing. The meter self-corrects on the
  next turn, since each snapshot reflects the current session tree.

## Theming

- Dark mode by default. Light mode toggle in settings.
- CSS variables for palette; no Tailwind required (keeps bundle small).
- System font stack. Monospace via `ui-monospace, Menlo, …`.

### Overlays & stacking

- One overlay tint, `--overlay`, dims the page behind both modal dialogs
  (`<dialog>::backdrop`) and the mobile sidebar scrim — they always match.
- Stacking is a documented scale in `src/app.css`; components reference the
  tokens instead of magic numbers: `--z-base` (sticky sub-headers, local
  dropdowns), `--z-sidebar` (mobile drawer + scrim), `--z-overlay` (floating
  menus / popovers), `--z-modal` (Modal dialogs), `--z-toast` (toasts).

## Settings → Extensions

Operator-managed pi extensions, added at runtime from the **Extensions** tab
(`/settings?tab=extensions`, backed by `/api/admin/extensions`) with no source
edits or server restart — the change applies to every conversation on its next
turn (the session pool re-matches on an extension fingerprint, disposing and
recreating cached sessions). The tab is gated like Models (`canRedeployUser`):
admin-only in multi-user mode.

Three kinds of sources:

- `file` — path to a `.ts` file/dir (`index.ts`), resolved against
  `PROJECT_ROOT` (absolute paths pass through).
- `inline` — TS source stored in the DB, materialized to
  `DATA_DIR/extensions/portal-ext-<id>.ts`.
- `package` — a pi spec `npm:<name>@<version>` / `git:<repo>@<ref>`, passed
  through `additionalExtensionPaths` unchanged; the SDK installs/clones it on
  demand into `<agentDir>/tmp/extensions/` (NOT the portal `DATA_DIR`). Pinning
  an explicit `@version`/`@ref` is **mandatory** — unpinned git sources re-pull
  on every session open.

Load semantics: only operator-listed sources load (`noExtensions: true` is
retained — no auto-discovery of `~/.pi/agent/extensions` or `.pi/extensions`).
Load failures are non-fatal: a broken/missing source logs and surfaces under
"Verify" (`{loaded, errors}`) but never blocks session creation. The tab warns
that extensions run with full system permissions and may execute arbitrary
remote code.

Known limitation: extension `ctx.ui` dialogs don't render in the headless
session (their promises resolve cancelled/undefined); event handlers and
`registerTool` work fully. Extension factories must not start long-lived
background resources — sessions are recreated whenever the extension set
changes.

## Accessibility

- All interactive components keyboard-operable.
- Permission prompt traps focus until decided.
- ARIA live region on the streaming message so screen readers announce
  meaningful chunks (debounced to ~1 s).

## Empty / error states

- New install with no conversations: large CTA, links to settings to verify
  the model session works.
- Auth missing: chat send is disabled with a banner pointing to `/settings`.
- SSE disconnect mid-stream: keep what was streamed, show "interrupted",
  offer "Resume" (which sends an empty continuation prompt).
