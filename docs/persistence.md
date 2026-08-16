# 06 — Persistence

Everything goes in a single SQLite database (`$DATA_DIR/portal.db`).
`better-sqlite3` for sync, embedded access. WAL mode enabled.

## Why SQLite

- Single-user / small-team workload. Postgres is overkill.
- Backup is a file copy.
- No external service to run alongside the portal container.

## Migrations

A single `001_init.sql` in `src/lib/server/db/migrations/` carries the full
current schema — fresh installs start from the final shape directly. Applied at
startup inside a transaction; tracked in a `schema_migrations(version,
applied_at)` table. No ORM, no migration framework.

The pi rebuild rebaselined the schema: the former per-step chain (`002`…`075`),
which grew the schema one feature at a time, was **deleted rather than
archived** (it lives on in git history). This is a hard break — a database whose
`schema_migrations` does not already carry every version `1`–`75` (any DB that
never ran the full chain) is stranded and must be recreated. Databases that
fully applied the old chain are unaffected: the runner sees `1` already applied,
skips `001`, and leaves the on-disk schema untouched. The only old-chain SQL that
survives is what the migration-behavior unit tests still exercise, relocated to
`tests/fixtures/migrations/`. Migration file names referenced in later sections
(`067_permission_shadow_decisions.sql`, `005_turn_snapshots.sql`, …) refer to
that deleted chain; the schema they introduced is folded into `001_init.sql`.

## Schema (representative excerpt)

```sql
-- 001_init.sql

CREATE TABLE users (
  id              TEXT PRIMARY KEY,         -- ULID
  github_login    TEXT UNIQUE NOT NULL,     -- 'local' or 'local:<key>' (single shared user)
  github_id       INTEGER UNIQUE,           -- legacy column; always NULL now (no auth)
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,         -- unix ms
  last_login_at   INTEGER
);

CREATE TABLE user_tokens (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- AES-256-GCM(plaintext, key=ENCRYPTION_KEY); nonce prepended.
  github_token_ct BLOB,
  byok_keys_ct    BLOB,                     -- JSON blob, encrypted
  updated_at      INTEGER NOT NULL
);

CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_model      TEXT,
  default_workdir    TEXT,
  default_policy     TEXT NOT NULL DEFAULT 'prompt',  -- 'prompt'|'allow-all'|'deny-all'
  theme              TEXT NOT NULL DEFAULT 'dark',
  updated_at         INTEGER NOT NULL
);

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,         -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  workdir         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,         -- ULID, sortable
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,            -- 'user'|'assistant'|'system'
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',  -- 'complete'|'interrupted'|'error'
  error_code      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  result_json     TEXT,
  status          TEXT NOT NULL,            -- 'pending'|'ok'|'error'|'denied'
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);

CREATE TABLE file_edits (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  diff            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE permission_grants (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,            -- '*' allowed
  granted_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, tool)
);

CREATE TABLE permission_decisions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_summary    TEXT,
  decision        TEXT NOT NULL,            -- 'allow-once'|'allow-always'|'deny'
  decided_at      INTEGER NOT NULL
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

## Adversary shadow decisions (Phase 0 measurement)

Added in migration `067_permission_shadow_decisions.sql`. Records what a second
model *would* have decided about a permission request that reached a human
dialog, next to what the human actually clicked, so adversary-deny
precision/recall can be measured before the idea is given any authority. The
adversary has no authority in this phase: nothing in the request path reads
these rows.

Kept out of `permission_decisions` on purpose — a shadow row is not a decision
(nothing acted on it), and the settings audit panel reads that table as "what
happened".

```sql
CREATE TABLE permission_shadow_decisions (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool             TEXT NOT NULL,
  permission_kind  TEXT NOT NULL,
  scope_key        TEXT,
  args_hash        TEXT,
  adversary_model  TEXT NOT NULL,
  experiment_key   TEXT NOT NULL,   -- hash of prompt + renderer + truncation + provider + model
  prompt_version   INTEGER NOT NULL DEFAULT 1,
  facts_key        TEXT,            -- hash of the exact facts; also the memo key
  prompt_sent      TEXT,            -- the exact prompt sent, for later adjudication
  resolution_source TEXT,           -- 'prompt-grant'|'prompt-policy'|'auto-approve'
  status           TEXT NOT NULL,   -- 'pending'|'verdict'|'error'
  verdict          TEXT,            -- 'allow'|'deny'; NULL unless status='verdict'
  deny_probability REAL,            -- self-reported, uncalibrated; unused in Phase 0
  rationale        TEXT,
  error            TEXT,
  latency_ms       INTEGER,
  memoized         INTEGER NOT NULL DEFAULT 0,
  human_decision   TEXT,            -- NULL = no human label; excluded from scoring
  human_decided_at INTEGER,
  created_at       INTEGER NOT NULL
);
```

A row is written by two independent writers that race: the fire-and-forget
adversary call, and the human's answer. Each updates only its own columns.
`human_decision` stays NULL when the prompt was cancelled or expired — a
cancelled prompt is explicitly not a denial, so those rows are excluded from
scoring rather than counted against the adversary.

Several columns exist purely so the data can still answer questions later, and
each would require throwing the collection away if added afterwards:

- `experiment_key` — measurements taken under different prompts, truncation
  budgets, backends or models are different experiments and must not be pooled.
  Computed, not hand-maintained, because a version constant someone must
  remember to bump is a trap; `prompt_version` is kept as its human-readable
  label.
- `adversary_model` / `experiment_key` — the same model *name* served by two
  providers is not the same reviewer (weights, system-prompt handling and
  structured-output support all differ), so the reviewer's identity is folded
  into `experiment_key`. The reviewer is a provider-qualified model selection
  (`providerId/modelId`, the `ADVERSARY_SHADOW_BACKEND` default or the
  per-conversation override), so the selection string itself is the identity:
  the same model served by two providers hashes to two different
  `experiment_key`s with no separate backend column at all. (A standalone
  `adversary_backend` column existed briefly in the provider-layer era (migration
  `069_adversary_backend.sql`) and was dropped when that layer went away.)
- `prompt_sent` / `facts_key` — the exact prompt the model was sent, so a
  disagreement can be adjudicated and a prompt change re-run against old cases,
  plus a hash of the facts so repeat askings of one question can be clustered
  (they are not independent samples). Storing the prompt rather than the raw
  facts keeps the copy at rest bounded by the same truncation budget as the
  network payload.
- `deny_probability` — lets a threshold be swept into a precision/recall *curve*
  instead of the one arbitrary operating point a binary verdict gives.
- `resolution_source` — `auto-approve` rows are the population a veto product
  would gate. They carry no human label by construction and are excluded from
  scoring; they are collected because the requests cannot be recovered later.

Read it with `pnpm run report:adversary-shadow`.

## Turn snapshots (edit-and-rerun)

Added in migration `005_turn_snapshots.sql`. Backs edit/retry forks by storing
manual restore points for the workdir. It does **not** make conversations
transactional or automatically rewind files.

```sql
CREATE TABLE turn_snapshots (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('pre', 'post')),
  git_ref      TEXT NOT NULL,           -- refs/portal/turns/{kind}/{id}
  commit_sha   TEXT NOT NULL,
  tree_sha     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);
ALTER TABLE conversations ADD COLUMN forked_from_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN forked_from_message_id TEXT;
```

The actual file state is **not** stored in SQLite. Each snapshot is a real
git commit written under the workdir's git repo at
`refs/portal/turns/{pre|post}/{messageId}`. `kind='pre'` is captured
before running a user turn; `kind='post'` is captured after the
assistant's reply persists. Trees are content-addressed so identical
worktree states across messages dedup naturally.

Snapshotting uses a per-snapshot `GIT_INDEX_FILE` so the workdir's normal
staging area is never touched. The `refs/portal/turns/` namespace is
private — it never overlaps `refs/heads/*` or `refs/tags/*`.

When a user edits a previous message, the portal:

1. Looks up the `pre` snapshot for that message (or `post` for the
   retry-from-assistant flavour) — for surfacing in the UI and as a
   manual restore point only.
2. Creates a new conversation with `forked_from_conversation_id` /
   `forked_from_message_id` set, sharing the source's `workdir`.
3. Clones the message rows strictly before the edited one into the new
   conversation, then appends the edited content as a fresh user message
   (for the edit flavour; the retry flavour clones up to and including
   the assistant target and appends nothing).
   - **Exception — source busy:** if the source has a *running* turn, the
     edit-fork is deferred: no user row is appended and the turn is not
     auto-started. The edited text is stored in `conversations.draft_prompt`
     (migration `041`) and seeded into the new conversation's composer on
     load so the user starts the turn manually.
4. Starts a brand-new SDK session under the new conversation id. No
   prior conversation events are seeded into the SDK in v1 — the agent
   starts fresh from the next prompt, using the live shared workdir. The
   cloned message rows exist for UI continuity only.

Limitations (v1):

- The fork shares the source's workdir. The portal does **not**
  automatically roll the files back to the snapshot — multiple
  conversations live in one tree, so a unilateral rewind would clobber
  other in-flight work. The snapshot ref is left in the repo so the
  user can `git diff`/`git restore` against it manually if they want
  to reproduce the prior state.
- A conversation boundary is a transcript/session boundary only. It is not a
  filesystem, git, process, network, or database isolation boundary.
- Side effects outside the workdir (DB writes, network calls) are not
  rolled back. Snapshots track files only.
- Submodule/LFS state is out of scope.

## Managed worktrees

Migration `061_managed_worktrees.sql` adds `conversations.workspace_kind`, a
stable `workspace_key`, and the `managed_worktrees` ownership table. The latter
records the source checkout, generated path, common Git directory, generated
branch, and base commit. Migration `062_snapshot_base_commit.sql` records the
HEAD commit alongside each snapshot tree so an isolated historical fork can
start from the correct ancestry and overlay the captured files as ordinary
unstaged/untracked changes. Snapshots created before migration `062` have no
recorded base commit; isolated forks from those snapshots start at the source
repository's current HEAD and still overlay the exact captured tree as working
changes.

Creating a managed conversation provisions Git first and then inserts the
conversation and metadata in one SQLite transaction. A database failure rolls
back the newly created worktree and generated branch. Archiving retains the
worktree. Deletion refuses dirty worktrees unless explicitly forced, removes
the linked checkout before deleting the database row, and deliberately keeps
the branch so committed work is not destroyed.

Existing conversations migrate as `shared`; no existing checkout is adopted
or deleted by the portal. A directory supplied through the legacy `workdir`
field is always shared even if it happens to be a Git worktree.

## Prompt template launch settings

Prompt templates (`chat` and `ticket-action` alike) carry the settings the chats
they launch are created with:

- `launch_behavior` — `send` (post the prompt as the first turn), `draft`
  (pre-fill the composer), or `review` (added in migration
  `065_prompt_template_workspace_mode.sql`'s era; opens a pre-launch dialog where
  the prompt **and** the settings below can be edited before sending). `NULL`
  means the per-type default: `draft` for chat templates, `send` for ticket
  actions, preserving the behavior each type had before the column applied to
  both.
- `workspace_mode` — `shared` or `worktree` (migration
  `065_prompt_template_workspace_mode.sql`). `NULL` means no preference and
  behaves like `shared`, so the column is a no-op for existing rows. A
  `worktree` template makes `POST /api/conversations` provision a managed
  worktree; an explicit `workspace` in the request always wins, which is how a
  review launch expresses a changed choice.
- `conversation_mode` / `approval_mode` / `model` — optional per-launch
  overrides. These were originally ticket-action-only and now apply to both
  types, since chat templates create conversations too. Existing chat rows hold
  `NULL` and keep using the user's defaults. `approval_mode` arrived with
  migration `066_approval_mode.sql`, which also rewrote any template pinned to
  the retired `best-effort` conversation mode into the equivalent
  `autopilot` + `auto-deny` pair.

## Conversation mode vs. approval mode

Two orthogonal per-conversation axes, split apart by migration
`066_approval_mode.sql`:

- `conversations.mode` — the portal's agent mode: `interactive` (every
  permission-worthy request raises a dialog) or `autopilot` (non-interactive,
  best-effort style). It is a portal-side policy that shapes how the
  interactive-request registry settles requests; it is not forwarded to the pi
  runtime. (A `plan` mode existed in earlier releases and was removed.)
- `conversations.approval_mode` — how the portal settles a permission request
  that neither a grant nor the user's policy already decided: `ask` (raise the
  dialog), `auto-approve` (settle as an approval, still audited `auto-allow`),
  or `auto-deny` (reject with actionable feedback, audited
  `auto-prompt-required`). Only `auto-approve` is mirrored into the runtime;
  the other two are pure portal logic and therefore work for every provider.

Before `066` these were tangled: the boolean `approve_all_tools` column carried
auto-approve, while auto-deny rode on a portal-only `best-effort` value of
`mode` that the bridge remapped to `autopilot` before the SDK ever saw it. The
two silently overlapped (approve-all won by evaluation order). The migration
backfills `approve_all_tools = 1 -> 'auto-approve'` and
`mode = 'best-effort' -> 'auto-deny'` (rewriting those rows' mode to
`autopilot`), then drops `approve_all_tools`. The same split is applied to
`user_settings.default_mode` / the new `default_approval_mode`. Because it is
one enum, the two settings are now mutually exclusive by construction, and
combinations that were unreachable before are expressible.

`request_permission_grant` always reaches a human dialog regardless of the
approval mode, and a denial in any mode mints a one-shot `force_retry_tool`
token that — when presented with a human-approved reason — auto-allows the
exact retried call so the SDK executes it natively.


## Turn input capture (observability)

Added in migration `034_turn_inputs.sql`. Records the **full input** the portal
handed to the provider for the turn triggered by a given user message — the
auto-injected portal prelude, any memory / prior-message context, and the raw
user content, exactly as the SDK saw it. Purely an observability artifact; it is
never read back into a turn.

```sql
CREATE TABLE turn_inputs (
  message_id       TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id          TEXT,
  full_input       TEXT NOT NULL,   -- prelude + body, exactly as sent
  prompt_body      TEXT NOT NULL,   -- body without the portal prelude
  prelude          TEXT NOT NULL DEFAULT '',
  model            TEXT,
  mode             TEXT,
  memory_mode      TEXT,
  initial_messages TEXT,            -- JSON array of embedded prior messages, or NULL
  created_at       INTEGER NOT NULL
);
```

Written by `turn-runner` the moment a turn starts (best-effort; a failed write
never breaks the turn), keyed by the triggering user message. Inline-edit
re-runs reuse that message id, so the row is upserted to reflect the latest
turn. Surfaced read-only in the chat UI via the "Input" affordance on user
messages, which lazily fetches
`GET /api/conversations/{id}/messages/{messageId}`.


## Conventions

- IDs are ULIDs (lexically sortable; safe in URLs).
- Timestamps are unix ms `INTEGER`.
- Sensitive fields end in `_ct` and are encrypted (AES-256-GCM with the
  `ENCRYPTION_KEY` env var; rotated by re-encrypt-and-rewrite migration).
- JSON columns are `TEXT`. Queried only by key paths via `json_extract()`,
  not used for joins.

## Repositories

Thin function modules under `src/lib/server/db/repos/`. No active record /
no ORM. Each function takes the user id when applicable, so authorization
is enforced at the data layer too:

```ts
// repos/conversations.ts
export function get(id: string, userId: string): Conversation | null { ... }
export function list(userId: string, opts: ListOpts): Conversation[] { ... }
export function create(userId: string, input: CreateConvInput): Conversation { ... }
export function rename(id: string, userId: string, title: string): void { ... }
export function touch(id: string): void { ... }
export function archive(id: string, userId: string): boolean { ... }
export function unarchive(id: string, userId: string): boolean { ... }
```

## Backup and export

- Restore is offline: stop the container, replace `portal.db`, start.
- `GET /api/conversations/:id/export` emits a single markdown file with
  the conversation's messages, tool calls, and diffs inlined.
- _Roadmap:_ `GET /api/export` will return a `portal.tar.gz` containing
  `portal.db` plus a `manifest.json` (excludes `user_tokens` and
  `byok_keys_ct` by default; flag to include). Not yet implemented — use
  the offline file-copy path until then.

## Admin and operations endpoints

A small set of endpoints exists outside the per-conversation CRUD surface.
They are reachable like the rest of `/api/*` (no auth — the app has a single
shared local user) and live alongside the data routes:

- `POST /api/admin/redeploy` — streams a Server-Sent Events feed of a
   `git fetch` / `git pull` / `pnpm install` / `pnpm run verify` pipeline,
   then exits the process so the supervisor (`scripts/serve.mjs`) can
   relaunch from the refreshed `build/`. Body: `{pull?: boolean}` (defaults
   to `true`). Gated by the `ENABLE_REDEPLOY` env flag — returns `403`
   when disabled and `409` if a redeploy is already in flight. The single
   local user is the operator and is allowed to trigger it. Only meaningful
   when the portal is started via `pnpm run serve`.
- `POST /api/conversations/:id/permissions/:requestId` — resolves a
  pending tool-permission prompt. Body:
  `{decision: 'allow-once' | 'allow-always' | 'deny'}`. Returns
  `{ok: true}` on success, `404` if the request id is unknown or no
  longer pending. The matching SSE feed for pending prompts is published
  via the conversation's event stream.

## Retention

No automatic deletion. The UI offers per-conversation delete (cascades).
Archived conversations are collapsed under an "Archived" group in the sidebar
but preserved; users can unarchive them or include them in API listings via
`GET /api/conversations?archived=1`.

## Repo-module conventions

The modules under `src/lib/server/db/repos/*.ts` are the only callers of
`better-sqlite3` outside migrations. They follow a small, uniform contract:

- **`getX(...) → X | null`** — a missing row returns `null`. No
  synthetic-default variants (use a sibling `defaults()` helper if the
  caller wants a fallback, e.g. `settings.get(uid) ?? settings.defaults()`).
- **`getOrCreateX(...) → X`** — idempotent get-or-insert. Always returns
  a real, persisted row (e.g. `users.ensureLocalUser`,
  `users.upsertGithub`).
- **Inserts that mint an entity** — return the inserted row
  (e.g. `convs.create`, `msgs.append`).
- **Scoped mutators** (UPDATE/DELETE with `AND user_id = ?` enforcing
  ownership) return `boolean` indicating whether the row was changed —
  callers use this to distinguish "applied" from "not yours / 404".
- **Unscoped mutators** (UPDATE/UPSERT on a known-trusted id, no
  authorization check) return `void`. Caller is expected to have
  authorized the entity beforehand.
