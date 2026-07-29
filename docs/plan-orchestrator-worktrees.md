# Plan: worktrees for orchestrator agents (workspace leases)

Ticket: `01KYP20N7QRHSAY1F0SKP6B0E1`

## Problem

An _orchestrator_ is an agent that fans work out in parallel — today via the CLI
`task` tool (`mode: background`), later possibly via spawned child conversations.
All of that work lands in **one checkout**: the provider session has a single
`workingDirectory` and sub-agents inherit it. Parallel edits collide, and git
state (index, HEAD, branch, stash) is per-working-tree, so "two agents, two
branches" is impossible today.

Managed worktrees already solve this, but they are welded 1:1 to a conversation:

| Constraint                                                              | Where                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| Path derived from `conversationId`                                      | `generatedPath`, `src/lib/server/worktrees.ts`    |
| Branch derived: `portal/<conversationId>`                               | `createManagedWorktree`                          |
| `managed_worktrees.conversation_id` is the PK → at most one per conversation | `migrations/061_managed_worktrees.sql`       |
| Created only at conversation-create and fork                            | `api/conversations/+server.ts`, `server/fork.ts`  |
| Destroyed only on conversation DELETE                                   | `api/conversations/[id]/+server.ts`               |
| Exactly one path resolved, fail-closed                                  | `resolveConversationWorkspace`, `server/workdir.ts` |
| Permission auto-allow anchored to ONE root                              | `permissions/{matcher,workspace}.ts`, `predicates/*` |
| Read endpoints derive containment from that one path                    | `conversation-auth.ts` → every `fs/*`, `git/*` route |

So an agent cannot obtain a second checkout; if it made one by hand (shell `git`
is prompt-seeded anyway), every write there would fall _outside_ the workspace
and prompt, and the portal UI would not show it.

## Locked decisions

1. **Serve intra-conversation fan-out first.** One transcript, orchestrator + N
   sub-agents, N checkouts. Conversation-per-work-unit ("spawn a child
   conversation") is a later, larger feature that needs this primitive anyway.
2. **New concept: a _lease_** — a portal-owned checkout with its own ULID
   identity, held by a conversation, with an independent lifecycle. Internally
   "lease"; **model-facing name is "worktree"** (concrete and familiar).
3. **Do NOT migrate `managed_worktrees` into the new table.** The conversation
   primary is load-bearing in the security-critical fail-closed path and in
   `CONVERSATION_SELECT`. Unifying them is churn with real regression risk and no
   v1 user-visible gain. Instead: a new `workspace_leases` table, shared git
   mechanics factored inside `worktrees.ts`, and ONE
   `conversationWorkspaceRoots()` helper that returns primary + leases. Recorded
   as a deliberate non-goal; file a follow-up if the duplication bites.
4. **Leases are user-owned rows with a `held_by_conversation_id` pointer**, not
   conversation-owned. Costs nothing now and is what handing a lease to a spawned
   conversation later requires.
5. **Leases are not snapshotted per message in v1.** Snapshotting N trees per
   message is a real cost. Document it and say so in the UI; "Changes" fidelity
   is the thing users will wrongly assume.
6. **No portal-driven merge in v1.** Lease branches are reported; the human
   merges. Merge automation is phase 5, behind an always-prompt tool.
7. **Sub-agent placement is advisory.** The orchestrator passes the absolute
   lease path in the sub-agent prompt. Nothing enforces it, because we do not
   control per-sub-agent cwd. This is the single riskiest assumption → **phase 0
   spike gates the whole plan.**

## 1. Path and branch derivation

Paths stay _derived from ids and verified_ — that is what makes fail-closed
resolution possible. Generalize `worktrees.ts` over a slot:

```ts
export type WorktreeSlot =
	| { kind: 'conversation'; userId: string; conversationId: string }
	| { kind: 'lease'; userId: string; leaseId: string };
```

| Slot           | Path                                       | Branch                              |
| -------------- | ------------------------------------------ | ----------------------------------- |
| `conversation` | `WORKTREE_ROOT/<userId>/<conversationId>`   | `portal/<conversationId>`           |
| `lease`        | `WORKTREE_ROOT/<userId>/leases/<leaseId>`   | `portal/lease/<leaseId>[--<label>]` |

The conversation form is **unchanged** — no on-disk migration, no `git worktree
move` against a checkout a live session may have as its cwd.

Required guards:

- `slotPath` **must reject `conversationId === 'leases'`** (one line + one test).
  Conversation ids are ULIDs so it cannot be minted today, but the existing
  `IDENTIFIER_RE` permits lowercase and the namespaces are siblings.
- `prepareGeneratedParent` currently asserts the realpath'd parent equals
  `<root>/<userId>`; generalize to the slot's expected parent
  (`<root>/<userId>/leases` for leases).
- `label` is sanitized to `^[a-z0-9][a-z0-9-]{0,32}$` (lowercased, non-matching
  input rejected — not silently coerced) before entering a branch name. `baseRef`
  already rejects a leading `-`.
- The existing `UNIQUE(git_common_dir, branch)` invariant holds by construction:
  the `portal/lease/` prefix can never collide with a primary's branch.

## 2. Schema — `migrations/063_workspace_leases.sql`

```sql
CREATE TABLE workspace_leases (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  held_by_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL DEFAULT '',
  source_workdir          TEXT NOT NULL,
  git_common_dir          TEXT NOT NULL,
  path                    TEXT NOT NULL UNIQUE,
  branch                  TEXT NOT NULL,
  base_sha                TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'releasing')),
  created_at              INTEGER NOT NULL,
  last_used_at            INTEGER NOT NULL,
  UNIQUE(git_common_dir, branch)
);

CREATE INDEX idx_workspace_leases_holder
  ON workspace_leases(held_by_conversation_id);
CREATE INDEX idx_workspace_leases_user_state
  ON workspace_leases(user_id, state);
```

`ON DELETE CASCADE` is a **backstop, not the cleanup path**: the row vanishing
would strand the directory, so conversation DELETE removes leases on disk first
(§6) and startup reconciliation sweeps whatever a crash left behind.

## 3. Service API — `src/lib/server/leases.ts`

```ts
export interface Lease {
	id: string;
	userId: string;
	heldByConversationId: string | null;
	label: string;
	sourceWorkdir: string;
	gitCommonDir: string;
	path: string;
	branch: string;
	baseSha: string;
	state: 'active' | 'releasing';
	createdAt: number;
	lastUsedAt: number;
}

createLease(input: { userId; conversationId; label; baseRef? }): Promise<Lease>;
listLeases(conversationId: string, userId: string): Lease[];
getLease(leaseId: string, userId: string): Lease | null;

/** Fail-closed path resolution. Mirrors `resolveConversationWorkspace`. */
resolveLeaseWorkspace(lease: Lease): string;

inspectLease(lease: Lease): Promise<{ dirtyCount: number; ahead: number; behind: number }>;
removeLease(lease: Lease, opts: { force?: boolean }): Promise<{ branchDeleted: boolean }>;
removeLeasesForConversation(conversationId, userId, opts): Promise<{ removed; retained: Lease[] }>;
reapIdleLeases(now: number): Promise<{ removed: number }>;
reconcileLeases(): Promise<{ rowsDropped: number; dirsPruned: number }>;

/** The containment set: primary workspace + every active lease. */
conversationWorkspaceRoots(conversation: Conversation): string[];
```

Behavioral contracts:

- **`createLease` never accepts a source repository argument.** It reads the
  holding conversation's persisted source (`managed_worktrees.source_workdir`
  for a managed primary, else `conversations.workdir`). Anything else turns
  `worktree_create` into an `ALLOWED_WORKDIRS` bypass.
- Reuses the existing per-`gitCommonDir` `withRepositoryLock`, so concurrent
  `worktree_create` calls from one orchestrator serialize correctly. The lock is
  **in-process only** — it does not protect against a second portal process or a
  human running git in the same repo.
- `removeLease` refuses when `dirtyCount > 0` unless `force`, matching today's
  conversation behavior.
- Branch cleanup uses `git branch -d` (merged-only), never `-D`. An unmerged
  lease branch is **left in the repo** and its name returned, so removing a
  worktree never silently destroys work. `rollbackManagedWorktree`'s existing
  `-D` stays as-is: it only ever runs on a just-created, never-used checkout.
- `resolveLeaseWorkspace` mirrors `resolveConversationWorkspace` exactly:
  recompute the expected path from ids, `realpathSync` both sides, require
  `isDirectory()`, require strict containment under `WORKTREE_ROOT`, and throw
  `WorkspaceUnavailableError` rather than falling back to anything.

## 4. Permission containment — the usability gate

Without this, every write inside a lease prompts and the feature is unusable.
Change the single workspace root into an ordered **set**:

| File                                          | Change                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `permissions/workspace.ts`                     | add `isPathInAnyWorkspace(target, roots)`; keep `isPathInWorkspace`                        |
| `permissions/matcher.ts` (~L67, 186, 288, 298) | `workspaceRoot?: string \| null` → `workspaceRoots?: readonly string[] \| null`             |
| `permissions/predicates/fs.ts` (~L41)          | `rule.root === 'workspace' ? ctx.workspaceRoots : [ctx.sessionWorkspaceRoot]`               |
| `permissions/predicates/shell.ts` (~L164, 222) | `workspace-paths` matches if the path is in **any** root                                    |
| `runtime/interactive-requests.ts` (~L586, 605) | `PolicyContext.workspaceRoots`; `decideByPolicy` uses `isPathInAnyWorkspace`                |
| `copilot/interactive-adapter.ts` (~L296, 309)  | pass `opts.getWorkspaceRoots()` instead of `opts.workingDirectory`                          |
| `providers/openai-compatible-provider.ts` (~L569) | same                                                                                    |

**`getWorkspaceRoots` must be a callback, not a value.** A lease created during
turn N has to be auto-allowed within turn N; a value captured at session
establishment would be stale exactly when it matters. This mirrors the existing
`getSessionWorkspacePath` / `getApproveAll` callback style.

`sessionWorkspaceRoot` stays **single** — it is the SDK's real cwd. Do not
conflate the two; `session-workspace` seeds must keep meaning "the actual cwd".

Empty/failed resolution must fail closed (prompt), as today.

## 5. Agent surface — the `worktree` tool group

Add `'worktree'` to `src/lib/tools/groups.ts` (`PortalToolGroupId`,
`PORTAL_TOOL_GROUPS`). The `GroupedPortalTools` `Record` type makes the compiler
force both providers to populate it; the settings checkbox UI and
`sanitizeDisabledToolGroups` pick it up for free.

Label: "Worktrees". Hint: "Create and manage isolated checkouts for parallel
sub-agent work."

```
worktree_create({ label: string, baseRef?: string })
  → { leaseId, path, branch, baseSha }
  followUpHint: "Hand the absolute `path` to a sub-agent and instruct it to work
                 only in that directory."

worktree_list({ fields? })
  → [{ leaseId, label, path, branch, dirtyCount, ahead, behind, createdAt, lastUsedAt }]

worktree_status({ leaseId })
  → { leaseId, label, path, branch, baseSha, dirtyCount, ahead, behind, changes }

worktree_remove({ leaseId, force?: boolean })
  → { removed: true, branch, branchDeleted }
```

Permission behavior:

- `worktree_create` — default (`'normal'`). No allow-seed shipped, so it prompts
  under the default `prompt` policy. Disk + branch creation should be visible.
- `worktree_remove` — **`permissionBehavior: 'always-prompt'`**. `PortalTool`
  exposes a static behavior, not an arg-dependent one, so "force must always
  prompt" is implemented by prompting for every removal. Acceptable: removal is
  destructive and rare.
- `worktree_list` / `worktree_status` — read-only; candidates for a
  `custom-tool` allow seed alongside the git/ticket structured tools.

Quotas (rejected with a `code` the model can act on):

- `WORKTREE_MAX_LEASES_PER_CONVERSATION` (default `8`) → `lease_quota_exceeded`
- `WORKTREE_MAX_LEASES_PER_USER` (default `32`) → `lease_quota_exceeded`

Audit: reuse `worktree_create` / `worktree_remove` event types, adding `leaseId`
and `label` to `detail`.

## 6. Lifecycle

- **Conversation DELETE** (`api/conversations/[id]/+server.ts`): after
  `pool.release`, remove the primary (existing) **and** call
  `removeLeasesForConversation`. A dirty lease → `409 { code: 'worktree_dirty' }`
  unless `?forceWorktree=1`, matching today's UX for the primary.
- **Reaper**: leases with `state='active'`, `dirtyCount === 0`, and
  `last_used_at` older than `WORKTREE_LEASE_TTL_MS` (default 24 h) are removed.
  Dirty leases are **never** auto-removed — only surfaced. Runs on the existing
  minute-cadence idle-reaper tick. Without this, every orchestrator run leaks
  checkouts.
- **`last_used_at`** is bumped by `worktree_create`/`_list`/`_status` and by any
  lease-scoped read endpoint, so an actively-inspected lease is never reaped.
- **Startup reconciliation** (`reconcileLeases`, once at boot): `git worktree
prune` per distinct `git_common_dir`; drop rows whose path is gone; remove
  directories under `WORKTREE_ROOT/<user>/leases/` with no matching row (crash
  or FK-cascade residue). Directory removal here is guarded by the same
  derived-path check as `removeUnavailableOwnedWorktree`.

## 7. Read surfaces and UI

- `authorizeConversationWorkdir(convId, userId)` gains a lease-aware sibling that
  reads an optional `?worktree=<leaseId>` param, verifies
  `lease.userId === conv.userId && lease.heldByConversationId === conv.id`
  (404 otherwise), and resolves via `resolveLeaseWorkspace`. Absent param =
  primary, so **every existing caller is unchanged**.
- Routes that accept it: `fs/tree`, `fs/file`, `fs/diff`, `git/changes`,
  `git/changes/revert`, `git/status`, `git/log`, `git/commit/[sha]`.
- New: `GET /api/conversations/[id]/worktrees` (list for the switcher) and
  `DELETE /api/conversations/[id]/worktrees/[leaseId]?force=1` (human escape
  hatch for a dirty lease the agent refused to drop).
- Files/Changes tabs get a workspace switcher (primary + leases, each with its
  dirty count). This is what makes an orchestrator run reviewable instead of a
  black box.
- The switcher shows an explicit note on a lease: **"Not snapshotted per
  message"** (decision 5).

## 8. System guidance

Add an orchestrator paragraph to `runtime/system-guidance.ts`, gated on the
`worktree_create` marker tool being present (the file already assembles guidance
from the tools a session actually exposes). Content: when fanning work out to
parallel sub-agents, create one worktree per unit, hand the sub-agent the
absolute path and instruct it to stay there, never point two sub-agents at one
tree, report branch names when done, and remove worktrees once merged.

## 9. Test matrix

Unit (`tests/`):

- derivation: lease path/branch; `conversationId === 'leases'` rejected; label
  sanitization accepts/rejects; `baseRef` leading-dash rejected
- create/remove: happy path; dirty refusal; force; quota exceeded; unmerged
  branch retained and reported; concurrent creates serialize
- fail-closed resolution: path outside `WORKTREE_ROOT`, symlink swap, missing
  dir, non-directory, another user's lease
- permissions: write inside primary auto-allows; inside a lease auto-allows;
  sibling-prefix `/…/leases/AB` vs `/…/leases/ABC` rejected; escaping symlink
  rejected; empty root set fails closed; a lease created mid-session is
  immediately covered (proves the callback, not a captured value)
- lifecycle: reaper skips dirty; reaper honors TTL; reconciliation prunes orphan
  dirs and drops orphan rows; conversation DELETE removes leases and 409s on dirty
- endpoints: `?worktree=` resolves; other user's / other conversation's leaseId → 404
- tools: schema errors (extend `tests/tool-schema-errors.test.ts`); group
  filtering with `worktree` disabled (extend `tests/conversation-tool-groups.test.ts`)

E2E (`e2e/`): create a managed-worktree conversation, exercise a lease, confirm
the Files tab switcher lists primary + lease and diffs render per-tree.

Every phase ends with `pnpm run verify`.

## 10. Phasing

- [ ] **Phase 0 — spike (gate).** Confirm a background sub-agent reliably does
      its work in an instructed absolute path outside the session cwd. If it does
      not, stop: the whole plan rests on this. Timebox; write the finding into
      this doc.
- [ ] **Phase 1 — lease primitive.** Migration 063, `leases.ts`, slot-based
      derivation, fail-closed resolution, reaper, reconciliation, conversation
      DELETE integration. No agent surface. Ships invisibly.
- [ ] **Phase 2 — multi-root permission containment.** §4. Ship with or
      immediately after phase 1; phase 3 is unusable without it.
- [ ] **Phase 3 — `worktree` tool group.** Tools, quotas, audit, system
      guidance. First user-visible capability.
- [ ] **Phase 4 — read surfaces + UI switcher.** Makes orchestrator runs
      reviewable.
- [ ] **Phase 5 — integration.** `worktree_integrate` = commit lease work to its
      branch and return the diff/branch. Portal-driven `git merge --no-ff` only
      behind an always-prompt tool, requiring a clean primary and **aborting and
      reporting** on conflict — never leaving a half-merged tree for an agent to
      clean up.
- [ ] **Phase 6 (optional) — conversation-per-work-unit.** Spawn a child
      conversation bound to an existing lease (`held_by_conversation_id` is
      already the hand-off pointer).

Phases 1–2 are shippable with no behavior change. Phase 3 is the first release
worth announcing. Phases 4–6 are independently valuable.

## 11. Risks

| Risk                                                          | Mitigation                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sub-agents ignore the instructed path                         | Phase 0 spike gates everything                                                 |
| Disk growth from N checkouts                                   | Quotas + reaper; `git worktree` shares objects, so cost is a checkout not a clone |
| In-process repo lock only                                      | Documented; git's own worktree locking is the backstop                          |
| Branch namespace pollution (`portal/lease/*`)                  | `-d` merged-only deletion; unmerged branches reported, not hidden               |
| Users assume "Changes" covers leases                           | Explicit UI note; revisit per-lease snapshots later                             |
| Permission refactor regresses the containment boundary         | It is a security boundary — the sibling-prefix and symlink-escape tests above are non-negotiable |
