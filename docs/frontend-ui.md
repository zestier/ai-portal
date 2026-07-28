# 04 — Frontend / UI

Svelte 5, SvelteKit file-based routing. Mobile-first responsive layout.

## Routes

| Path                         | Purpose                                                |
|------------------------------|--------------------------------------------------------|
| `/`                          | Conversation list + "New chat" CTA.                    |
| `/conversations/[id]`        | Chat view for a single conversation.                   |
| `/settings`                  | User settings, backend status, model defaults, default workdir, etc. |
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

### `Message.svelte`

Renders one message. Assistant content is markdown → sanitized HTML
(`marked` → `DOMPurify`, client-side). Code blocks render as plain
`<pre><code>` with copy buttons; syntax highlighting is a Phase 4
enhancement. Tool calls and file edits are rendered as folded inline
cards.

### `ToolCall.svelte`

Folded card showing tool name, status (pending/running/ok/error), and
expanding to show arguments and result/output.

### `DiffView.svelte`

Renders unified diff with side-by-side or inline toggle. Per-edit
"open in editor" link is just informational on the web build; on desktop,
clicking the path copies it to clipboard.

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
Copilot SDK can ask for: tool permission (Allow once / Allow always /
Deny), auto-mode-switch on rate limit, user_input (choices + freeform),
elicitation (schema-driven form or url mode), exit_plan_mode (per-action
buttons), and informational sampling / mcp_oauth / external_tool surfaces.
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
threshold: green below 70%, amber 70–90%, red above 90%. Clicking the bar
toggles a per-bucket breakdown (system / conversation / tools / messages) when
the SDK provided one.

Data flow:

- Initial value comes from `+page.server.ts`, which reads the latest snapshot
  from the `conversation_usage` table and passes it to `Chat.svelte` as
  `initialUsage`.
- Live updates arrive on the SSE stream as `context.usage` events (translated
  from `session.usage_info` by the server-side bridge) and are merged into
  local component state.
- `context.compaction` events with `phase: 'complete'` show a transient
  "✨ compacted · −N tokens" notice next to the meter that auto-dismisses
  after a few seconds.

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

## Accessibility

- All interactive components keyboard-operable.
- Permission prompt traps focus until decided.
- ARIA live region on the streaming message so screen readers announce
  meaningful chunks (debounced to ~1 s).

## Empty / error states

- New install with no conversations: large CTA, links to settings to verify
  Copilot auth.
- Auth missing: chat send is disabled with a banner pointing to `/settings`.
- SSE disconnect mid-stream: keep what was streamed, show "interrupted",
  offer "Resume" (which sends an empty continuation prompt).
