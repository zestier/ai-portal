# 01 — Architecture

## Components

### 1. SvelteKit app (single deployable unit)

Runs under `@sveltejs/adapter-node`. Serves:

- **Client routes** — chat UI, session list, settings.
- **Server endpoints** (`+server.ts`) — REST-ish JSON API and SSE streams.
- **Hooks** (`hooks.server.ts`) — single local user, CSRF/origin hardening, headers, request logging.

A single Node process. No separate API server.

### 2. Agent session layer

A server-side module (`$lib/server/pi/`) that opens and drives model sessions
through the [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
SDK. A process-wide `ModelRuntime` resolves the configured `PI_MODEL`
(`providerId/modelId`); `PI_STUB=1` swaps in an in-process OpenAI-compatible
stub model for e2e tests. Responsible for:

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
default to `PROJECT_ROOT`, but can override it; the pi agent, turn
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

### Worktree leases (parallel sub-agent work)

A conversation's own workspace is one tree, which is a problem for an
_orchestrator_ — an agent that fans work out to several sub-agents at once,
since concurrent edits to one tree corrupt each other and git state (index,
HEAD, branch) is per-tree.

A **lease** (`workspace_leases`, `src/lib/server/leases.ts`) is a second kind of
portal-owned checkout, addressed by its own ULID rather than by the conversation
id: `WORKTREE_ROOT/<userId>/leases/<leaseId>` on branch
`portal/lease/<leaseId>[--<label>]`. It is held by a conversation but stored as
a user-owned row, so it can later be handed to a spawned child conversation.
Path derivation, containment, locking, and rollback are shared with the
conversation primary via `createWorktreeForSlot`, and resolution fails closed the
same way.

A lease's counterpart in both directions is the **holding conversation's
workspace**, not the repository's main checkout: it is cut from that tree's HEAD
and merges back into that tree's branch. Sub-agents therefore start from the
orchestrator's current state, and their results gather into one branch to be
reviewed and tested together before any of it reaches the shared checkout. For a
shared-workdir conversation the counterpart *is* the main checkout, so this
degenerates to the obvious behavior. `worktree-integration.ts` supports this via
an optional `upstreamPath`; without it, "to-source" would mean the repository's
main worktree and every lease would bypass the conversation that owns it.

Three properties are load-bearing rather than incidental:

- **Leases widen the permission boundary, not just the file browser.** A
  conversation's writable area is the SET of roots returned by
  `conversationWorkspaceRoots` — its own workspace plus every lease it holds —
  supplied to the permission matcher as a live callback so a lease created
  mid-turn is writable within that turn. Without this an agent cannot use a
  lease at all: the write is auto-denied under non-interactive modes, and the
  observed fallback is a stray write into the shared tree.
- **Merging back is the point.** A lease whose work is never merged is work
  thrown away, so `worktree_merge` (and the switcher's merge action) close the
  loop. Collecting the second and later leases of a parallel run is not a
  fast-forward: sync the lease with `from-source` and merge it back with
  `squash` to keep the conversation's history linear and one-commit-per-lease,
  or fall back to `allowMergeCommit`, which is expected there rather than
  exceptional. A conflict merging *into* the conversation is always rolled back;
  the lease is where an agent is supposed to resolve conflicts.
- **Leases are not snapshotted per message.** Per-turn snapshots capture the
  conversation's own tree only, so the workspace switcher labels a selected
  lease accordingly rather than letting "Changes" imply full coverage.

Agents manage leases with the `worktree` tool group
(`worktree_create`/`_list`/`_status`/`_merge`/`_remove`); humans get the same
operations over `/api/conversations/<id>/worktrees`, and the
Files/Changes/Commits panes take an optional `?worktree=<leaseId>` selector.
Quotas (`WORKTREE_MAX_LEASES_PER_*`) plus an idle reaper bound disk growth; the
reaper never collects a lease with uncommitted changes, and removal only ever
deletes a fully merged branch, so committed work survives as a branch rather
than being destroyed.

Isolation is only half a lifecycle, so `src/lib/server/worktree-integration.ts`
covers the other half: getting the work back. It derives a worktree's position
from git rather than from `managed_worktrees` — `git worktree list --porcelain`
names the repository's main checkout, and the branch checked out there is
treated as "upstream" — then reports ahead/behind/dirty counts and merges in
either direction.

The two merge directions are deliberately asymmetric, because only one of the
two trees is shared with a human:

- `from-source` merges upstream into the worktree. A conflict may be left in
  place (opt-in, `onConflict: "keep"`) since that isolated tree is exactly where
  an agent should resolve it. Leaving it there is only useful if the agent can
  also get *out* of it, so the tool surface closes that loop without shell git:
  `git_status` reports the in-progress merge and its still-conflicted paths,
  `git_commit` with `paths: "all"` stages exactly the resolved conflicts and
  creates the merge commit (mid-merge it deliberately does NOT sweep the rest of
  the tree, refuses a path selection, and refuses a "resolved" file that still
  contains conflict markers unless `allowConflictMarkers` says the markers are
  deliberate), and `git_merge_abort` rolls the whole merge back. A tree that is
  instead mid-*sequencer* — a rebase or multi-step cherry-pick, which the portal
  never starts — is reported as such by `git_status`, with guidance that says
  plainly that committing does not advance it and no structured `--continue`
  exists, rather than implying a recovery the tool surface does not have.
- `to-source` merges the worktree branch into the source checkout. It must
  fast-forward by default, refuses when either tree is dirty, and always rolls
  a conflict back — the source checkout is never left mid-merge.
- `squash` (a `to-source` option, with a caller-supplied commit subject)
  collapses the worktree's commits into one **on the worktree's own branch**
  first — `reset --soft` to the source branch's tip, then commit — so the
  following fast-forward hands the source exactly one commit per unit of work,
  absorbing any merge commit an earlier `from-source` sync left behind. It is
  in-branch rather than `git merge --squash` into the source deliberately: the
  branch ref keeps pointing at the squashed commit, so `ahead` / `unmerged` stay
  correct afterwards, where `merge --squash` would leave the branch reporting
  unmerged work forever. It refuses when the worktree is `behind` (squashing
  onto a stale tip would revert the source's own commits — sync first) and
  forces the fast-forward, so `allowMergeCommit` has no effect alongside it.
  The squash commit runs the repository's hooks like any other: its tree is
  already-committed content, but its *message* is new, and after the squash it
  is the only message on the branch.

Every operation that mutates a repository — `git worktree add`, `git worktree
remove`, either merge direction, and the commit/abort pair that concludes or
discards a merge — serializes on the shared, in-process
`withRepositoryLock` (`src/lib/server/repo-lock.ts`), keyed on the repository's
git common dir so a repository's main worktree and all of its linked worktrees
share one key. A merge re-reads its status *inside* that lock, because the
dirty/ahead/behind guards are a check-then-act on state another operation could
otherwise invalidate. This is a same-process mutex only; git's own `index.lock`
is what guards against unrelated processes.

Agents drive this with `git_worktree_status` / `git_worktree_merge`, and`git_commit` adds a follow-up hint pointing at integration whenever it commits
inside a linked worktree. `git_worktree_list` covers discovery: it enumerates
every worktree of the repository (main plus linked, with branch/HEAD and
detached/locked/prunable flags) straight from `git worktree list`, so unlike the
lease-oriented `worktree_list` it also sees trees the portal did not create.
Every read-only git tool additionally takes an optional `worktree: <leaseId>`
selector that runs it inside a lease this conversation holds, so an orchestrator
can `git_status` / `git_diff` / `git_log` a sub-agent's checkout instead of being
blind to it until the merge — the tool-side counterpart of the `?worktree=`
selector on the Files/Changes/Commits routes. `git_commit` takes the same
selector, and it is the only sanctioned way to commit inside a lease: no git
shell grant is seeded, so without it a sub-agent could write in a worktree but
never land the work, leaving `worktree_merge` nothing to collect. Its approval
prompt therefore names the destination lease, branch, and path (resolved
server-side from the id), so a human is never asked to approve a commit without
knowing which tree it lands in. The lease must be held by the
calling conversation (same check as `worktree_status`), which is why the
selector cannot widen reach: those paths are already among the roots
`workspaceRootsFor` grants it. `GET /api/worktrees/status` feeds the sidebar's
"unmerged" badge (`?fresh=1` skips its short TTL cache),
`GET|POST /api/conversations/<id>/worktree[/merge]` back the
chat header's integration panel, and deleting a conversation whose worktree
still holds unmerged commits requires the same `forceWorktree=1` confirmation
that a dirty one does. Both indicators are event-driven as well as polled: a
turn ending or a merge landing bumps `worktreeStatusRevision`
(`$lib/client/worktree-status`) and they refetch, since git changes underneath
the UI and a badge that only updates on reload is worse than no badge.

### 5. Remote access (deployment-time, no auth)

The app has **no authentication layer**; remote access is a networking concern.
The recommended path is to expose the loopback port over a **Tailscale tailnet**
(Tailscale Serve). See [deployment.md](deployment.md) and
[auth-and-security.md](auth-and-security.md).

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
elicitation, plus info-only sampling/mcp_oauth/external_tool)
all flow through one endpoint:
`POST /api/conversations/:id/interactive/:requestId` with a
discriminated `{ kind, ... }` body. The legacy
`/permissions/:requestId` endpoint remains as a one-release shim.

## Concurrency model

- **One shared pi `ModelRuntime` per portal process**, created lazily on first
  use (`pi/index.ts`). Auth and model-catalog state live on the runtime, so
  every pi session sees the same snapshot; `PI_STUB=1` registers the stub
  model on it once. In the common single-user deployment there is exactly one
  entry.
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

- **SDK session failure** — surfaces as an error; the session is marked dead
  and disposed, a system message is persisted in the conversation, and the
  next user message respawns it.
- **Network error to the model provider** — surfaced as a normal `error` event;
  user can retry without losing conversation state.
- **Server restart** — conversations are durable in SQLite. SDK sessions
  are ephemeral and recreated on demand. Any in-flight assistant turn that was
  not finalized is marked `interrupted` and shown as such in the UI.
