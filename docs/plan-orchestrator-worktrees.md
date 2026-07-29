# Plan: worktrees for orchestrator agents (workspace leases)

Ticket: `01KYP20N7QRHSAY1F0SKP6B0E1`

**Part I (§1–11)** is the design spec: what we are building and why.
**Part II (§12–20)** is the implementation plan: the ordered, commit-sized work
breakdown. Read Part I once; work from Part II.

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

- [x] **Phase 0 — spike (gate).** Confirm a background sub-agent reliably does
      its work in an instructed absolute path outside the session cwd. If it does
      not, stop: the whole plan rests on this. Timebox; write the finding into
      this doc. **Done — AMBER-GREEN, see §12.**
- [x] **Phase 1 — lease primitive.** Migration 063, `leases.ts`, slot-based
      derivation, fail-closed resolution, reaper, reconciliation, conversation
      DELETE integration. No agent surface. Ships invisibly.
- [x] **Phase 2 — multi-root permission containment.** §4. Ship with or
      immediately after phase 1; phase 3 is unusable without it.
- [x] **Phase 3 — `worktree` tool group.** Tools, quotas, audit, system
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

---

# Part II — Implementation plan

Work items are **commit-sized**: each is one reviewable change that leaves the
repo green (`pnpm run verify`). IDs (`W0.1`, `W1.2`, …) are stable references for
commit messages and ticket checklists.

Conventions for every item:

- Tests land **in the same commit** as the behavior they cover (CONTRIBUTING).
- Run `pnpm test <path>` for the touched file, then `pnpm run verify` before
  declaring an item done.
- Commit subject: `<area>: <what>` with a `Ticket: <id>` line.

## 12. Phase 0 — the spike (GATE)

Everything downstream assumes a sub-agent honors an instructed absolute path.
Nothing enforces it. **Do not start Phase 1 until this answers yes.**

### W0.1 — Sub-agent path-adherence spike

Not a code change. Timebox to one session.

1. `pnpm dev:isolated` in a scratch git repo with a managed-worktree conversation.
2. By hand: `git worktree add /tmp/spike-a -b spike/a` from that repo.
3. Launch a background sub-agent (`task`, `mode: background`) with a prompt of the
   form: _"All work happens in `/tmp/spike-a`. Create `probe.txt` there. Do not
   touch any other directory."_
4. Repeat ~5× across the models an orchestrator would realistically use, and
   include one prompt where the sub-agent must **read** an existing file in the
   lease and one where it must **edit** it (editing is likelier to drift back to
   the session cwd than creating).

Record per run: did the file land in the lease, did anything land in the session
cwd, and did the agent need reminding.

**Exit criteria.** Green: ≥80% clean adherence, and stray writes land in the
session cwd (visible, recoverable) rather than somewhere unexpected → proceed.
Amber: adherence only with heavy prompt scaffolding → proceed, but W3.4's system
guidance becomes load-bearing and needs the winning phrasing verbatim. Red:
sub-agents routinely ignore the path → **stop and re-scope**; the fallback is
Phase 6 (conversation-per-work-unit), where cwd is set by the portal rather than
requested of the model.

### Result — 2026-07-29: AMBER-GREEN, proceed

Run as three parallel background sub-agents told to create, read back, and then
edit a file in an absolute path outside the session cwd.

| Run | Model | Outcome |
| --- | ----- | ------- |
| A | claude-sonnet-4.6 | Blocked at directory bootstrap. Wrote nothing anywhere. |
| B | gpt-5.6-terra | **Clean.** Created, read back, and edited the file at the instructed path. No strays. |
| C | claude-haiku-4.5 | Blocked at directory bootstrap — and **wrote `calc.js` into the repo root instead.** |

**Adherence itself is not the risk.** No agent ever decided to ignore the
instructed path. B complied exactly, including the edit step. A and C both
*tried* to comply and reported the blockage honestly. The design's core
assumption — that a sub-agent will work where it is told — held in every run.

**The blocker was directory bootstrap, not writing.** A's investigation is
conclusive: `create` (fs-write) *is* auto-allowed for out-of-workspace
session-workspace paths, but it requires the parent to already exist;
`create_directory` and `move` are workspace-relative only; shell `mkdir` is
auto-denied under `best-effort`. B only succeeded because GPT-family models
carry a native `apply_patch` that implicitly creates parent directories —
a tool Claude-family agents are not given. So bootstrap capability varies by
model family, which is not something to build on.

Two consequences, both already satisfied by the design but worth stating:

1. **Phase 2 is a correctness prerequisite, not a usability nicety.** The spec
   called it "the usability gate" on the theory that a missing root only costs
   extra prompts. That holds only in interactive mode. Under `best-effort` /
   autopilot the out-of-root write is *auto-denied*, and C's observed fallback
   was a silent stray write into the shared workspace — precisely the collision
   leases exist to prevent. §14 is reclassified as blocking for correctness, and
   W2.5 must include a stray-write regression.
2. **The portal must pre-create the lease directory** — which is exactly what
   `git worktree add` does before any agent sees the path, so no design change
   is needed. This is independently the top recommendation from run A. W3.2's
   `followUpHint` must state that the directory already exists and is writable,
   so a sub-agent never attempts to create it and never concludes the path is
   unusable.

Verdict: **proceed to Phase 1**, with §14 promoted to a correctness gate.


## 13. Phase 1 — the lease primitive

Behavior-neutral: no agent surface, no UI. Ships invisibly.

### W1.1 — Generalize worktree derivation over a slot

`src/lib/server/worktrees.ts`, `tests/worktrees.test.ts`

- Add `WorktreeSlot` (§1) and `slotPath(slot)` / `slotBranch(slot, label?)`.
- Reimplement `generatedPath` / `expectedManagedWorktreePath` in terms of the
  `conversation` slot so the existing path is provably unchanged.
- Generalize `prepareGeneratedParent` to assert the slot's expected parent.
- Add `sanitizeLeaseLabel` (`^[a-z0-9][a-z0-9-]{0,32}$`, reject don't coerce).
- **Reject `conversationId === 'leases'`** in the conversation slot.

Tests: conversation paths byte-identical to before; lease path/branch shape;
`'leases'` rejected; label accept/reject table; parent-escape still throws.

Acceptance: no caller outside `worktrees.ts` changes.

### W1.2 — Config knobs

`src/lib/server/config.ts`, `tests/worktrees.test.ts`, `README`/`docs/deployment.md`

`WORKTREE_MAX_LEASES_PER_CONVERSATION` (8), `WORKTREE_MAX_LEASES_PER_USER` (32),
`WORKTREE_LEASE_TTL_MS` (86_400_000). Same `z.coerce.number().int().positive()`
style as `WORKTREE_CREATE_TIMEOUT_MS`. There is no dedicated config test file;
assert the defaults alongside the worktree tests that consume them.

### W1.3 — Migration + repo

`src/lib/server/db/migrations/063_workspace_leases.sql`,
`src/lib/server/db/repos/leases.ts`, `tests/leases-repo.test.ts`

DDL exactly as §2. Repo: `insert`, `getById(id, userId)`,
`listByConversation(convId, userId)`, `countByConversation`, `countByUser`,
`touch(id)`, `setState`, `remove`, `listAll` (reconciliation).

Note: the migration runner (`db/index.ts`) picks files up by sorted filename —
no registration step.

### W1.4 — Lease service: create + resolve

`src/lib/server/leases.ts`, `tests/leases.test.ts`

`createLease`, `getLease`, `listLeases`, `resolveLeaseWorkspace`, `inspectLease`.

Critical details:

- Source repo resolved from the **holding conversation** — never an argument.
- Reuse `withRepositoryLock` on `gitCommonDir`.
- Quota check inside the lock, before `git worktree add`.
- `resolveLeaseWorkspace` mirrors `resolveConversationWorkspace` clause for
  clause (recompute expected path, realpath both sides, `isDirectory()`, strict
  containment, throw `WorkspaceUnavailableError` — no fallback).
- Roll back the checkout if the row insert throws (mirror the create-route
  pattern).

Tests: happy path; quota exceeded; concurrent creates serialize; every
fail-closed branch (outside root, symlink swap, missing, non-directory, other
user's lease).

### W1.5 — Lease removal

`src/lib/server/leases.ts`, `tests/leases-remove.test.ts`

`removeLease` (dirty refuses without `force`), `removeLeasesForConversation`
(returns `retained` so the route can 409 precisely).

Branch cleanup is `git branch -d` (merged-only); on failure keep the branch and
return `branchDeleted: false`. Never `-D`.

Tests: clean removal deletes branch; unmerged branch retained + reported; dirty
refused; `force` removes; missing directory prunes without throwing.

### W1.6 — Containment set helper

`src/lib/server/workdir.ts` (or `leases.ts`), `tests/workdir.test.ts`

`conversationWorkspaceRoots(conversation): string[]` — primary first, then each
active lease that resolves. A lease that fails to resolve is **skipped, not
fatal**: one broken lease must not lock the user out of their primary workspace.
Deduplicate.

This is the single seam Phase 2 consumes.

### W1.7 — Reaper + startup reconciliation

`src/lib/server/leases.ts`, `src/lib/server/runtime/pool.ts` (or a sibling
`runtime/lease-maintenance.ts`), `src/hooks.server.ts`, `tests/lease-gc.test.ts`

- `reapIdleLeases(now)`: `state='active'`, `dirtyCount === 0`,
  `last_used_at` older than TTL. **Never** auto-removes a dirty lease.
- `reconcileLeases()`: `git worktree prune` per distinct `git_common_dir`; drop
  rows whose path is gone; remove orphan dirs under
  `WORKTREE_ROOT/<user>/leases/` guarded by the same derived-path check as
  `removeUnavailableOwnedWorktree`.
- Wire reconciliation into `boot()` in `hooks.server.ts` (next to
  `startIdleReaper()`), and the reaper onto a 60s interval with `timer.unref?.()`,
  following the existing pool-reaper shape.

Tests use fake timers, mirroring `tests/interactive-idle-reaper-repro.test.ts`.

### W1.8 — Conversation DELETE removes leases

`src/routes/api/conversations/[id]/+server.ts`, `tests/worktree-routes.test.ts`

After the existing primary removal, call `removeLeasesForConversation` with the
same `forceWorktree` flag. Dirty → `409 { code: 'worktree_dirty' }` listing the
retained leases. Audit `worktree_remove` per lease.

Ordering: leases first, then primary, then `convs.remove`. Leases are children of
the same repo; failing after the primary is gone leaves a messier state.

**Phase 1 acceptance:** `pnpm run verify` green; no user-visible change; a lease
can be created, resolved, inspected, and removed from a unit test.

## 14. Phase 2 — multi-root permission containment

**Correctness gate** (promoted from "usability gate" by the Phase 0 result,
§12). Without the lease in the agent's allowed roots, an out-of-root write is
auto-denied under non-interactive modes and the observed fallback is a stray
write into the shared workspace — the exact collision leases exist to prevent.
Behavior-neutral on its own (one root in, one root out).

### W2.1 — `isPathInAnyWorkspace`

`src/lib/server/permissions/workspace.ts`, `tests/workspace-permission.test.ts`

Add the plural helper; keep `isPathInWorkspace` as the singular case. Empty array
→ `false` (fail closed).

### W2.2 — Thread the root set through the matcher

`permissions/matcher.ts`, `permissions/predicates/fs.ts`,
`permissions/predicates/shell.ts`, `tests/permission-matcher.test.ts`,
`tests/predicates-fs-url.test.ts`, `tests/predicates-shell.test.ts`,
`tests/seed-grants.test.ts`

`workspaceRoot: string | null` → `workspaceRoots: readonly string[] | null` at
matcher L67/186/288/298; `predicates/fs.ts` L41; `predicates/shell.ts` L164/222.
`sessionWorkspaceRoot` stays singular.

Do this as a **mechanical rename with no behavior change** — pass a single-element
array at every call site — so the diff is reviewable as a refactor.

### W2.3 — Policy path

`runtime/interactive-requests.ts` (L586, L605), `tests/interactive-requests.test.ts`

`PolicyContext.workspaceRoots`; `decideByPolicy` uses `isPathInAnyWorkspace`.

### W2.4 — Provider adapters supply live roots

`copilot/interactive-adapter.ts` (L67, L296, L309),
`providers/openai-compatible-provider.ts` (L569),
`tests/permission-live-roots.test.ts`

Replace `workingDirectory: string` in `InteractiveAdapterOptions` with
`getWorkspaceRoots(): string[]`, alongside the existing `getSessionWorkspacePath`
callback. Both providers pass
`() => conversationWorkspaceRoots(conversation)`.

**`workingDirectory` is still needed** at L119 for `maybeCaptureImage` — that
guard is deliberately anchored to the session cwd. Keep the field; add the
callback. Do not collapse them.

The regression test that matters: a lease created **mid-session** is auto-allowed
within the same turn. That is what proves a callback rather than a captured value.

### W2.5 — Sibling-prefix and symlink-escape hardening tests

`tests/workspace-permission.test.ts`

`/…/leases/AB` must not match a root of `/…/leases/ABC`; a symlink inside a lease
pointing out must not auto-allow; empty root set prompts. This is a security
boundary — these are non-negotiable.

**Phase 2 acceptance:** `pnpm run verify` green; writes inside a lease auto-allow
under the default `prompt` policy; writes outside every root still prompt.

## 15. Phase 3 — the `worktree` tool group

First user-visible capability.

### W3.1 — Register the group

`src/lib/tools/groups.ts`, `tests/conversation-tool-groups.test.ts`

Add `'worktree'` to `PortalToolGroupId` + `PORTAL_TOOL_GROUPS`. The
`GroupedPortalTools` `Record` type makes the compiler force both providers to
populate the key; the settings UI and `sanitizeDisabledToolGroups` follow for
free.

### W3.2 — The tools

`src/lib/server/tools/worktree.ts`, `tests/worktree-tools.test.ts`,
`tests/tool-schema-errors.test.ts`

`buildWorktreeTools({ userId, conversationId })` returning the four tools of §5.
Zod schemas `.strict()`, `parameters` JSON Schema, `project()`-style compact
results with `FIELDS_PARAM` on `worktree_list`.

`worktree_remove` sets `permissionBehavior: 'always-prompt'`.

Quota rejections return `err(msg, { code: 'lease_quota_exceeded' })` so the model
can react rather than retry blindly.

`worktree_create` sets the `followUpHint` from §5 — that hint is what makes the
orchestrator hand the path to a sub-agent.

### W3.3 — Wire into both providers

`copilot/copilot-provider.ts` (~L241), `providers/openai-compatible-provider.ts`
(~L979)

Add `worktree: buildWorktreeTools(...)` to the `filterPortalToolGroups` record.

### W3.4 — System guidance + audit

`runtime/system-guidance.ts`, `tests/system-guidance.test.ts`; audit detail in
`tools/worktree.ts`

Orchestrator paragraph gated on the `worktree_create` marker tool (§8). If W0.1
came back amber, use the phrasing that actually worked in the spike.

Audit `worktree_create` / `worktree_remove` with `leaseId` + `label`.

**Phase 3 acceptance:** in `pnpm dev:isolated`, an agent creates a worktree,
writes in it without prompting, and removes it (with a prompt). Group can be
disabled from settings.

## 16. Phase 4 — read surfaces and UI

### W4.1 — Lease-aware authorization helper

`src/lib/server/conversation-auth.ts`, `tests/conversation-auth.test.ts`

`authorizeConversationWorkspace(convId, userId, leaseId?)`: no `leaseId` →
today's behavior exactly; with one → verify
`lease.userId === conv.userId && lease.heldByConversationId === conv.id` (404
otherwise), resolve via `resolveLeaseWorkspace`, bump `last_used_at`.

Keep `authorizeConversationWorkdir` as a thin delegate so **no existing caller
changes in this commit**.

### W4.2 — Accept `?worktree=` on the read routes

`fs/tree`, `fs/file`, `fs/diff`, `git/changes`, `git/changes/revert`,
`git/status`, `git/log`, `git/commit/[sha]`; `tests/worktree-routes.test.ts`

One-line change per route. Test the cross-user and cross-conversation 404s once,
centrally.

### W4.3 — Lease list/delete endpoints

`src/routes/api/conversations/[id]/worktrees/+server.ts` and
`.../worktrees/[leaseId]/+server.ts`

`GET` (list + dirty counts) and `DELETE ?force=1` — the human escape hatch for a
dirty lease the agent refused to drop.

### W4.4 — Files/Changes workspace switcher

`src/lib/components/FileBrowser.svelte`, the Changes view, `+page.svelte`

Dropdown: primary + leases with dirty counts; selection appends `?worktree=`.
Show the **"Not snapshotted per message"** note on a lease (decision 5).

Per AGENTS.md: iterate visually with `playwright-cli` (Firefox) at 390px and
desktop, light and dark, before calling it done.

### W4.5 — E2E

`e2e/worktrees.spec.ts` — create a managed-worktree conversation, exercise a
lease, assert the switcher lists both and diffs render per-tree.

## 17. Phase 5 — integration

### W5.1 — `worktree_integrate` (report-only)

Commit lease work to its branch, return branch + diffstat. No merge. Low risk,
most of the value.

### W5.2 — Portal-driven merge (gated)

`git merge --no-ff` of a lease branch into the primary. Requires a clean primary;
`always-prompt`; **aborts and reports** on conflict — never leaves a half-merged
tree for an agent to clean up.

Reassess whether W5.2 is wanted at all after W5.1 has been used in anger.

## 18. Phase 6 (optional) — conversation-per-work-unit

Spawn a child conversation bound to an existing lease.
`held_by_conversation_id` is already the hand-off pointer. Scope this only after
Phases 3–4 have real usage — and treat it as the **fallback plan if W0.1 came
back red**, since there the portal sets cwd instead of asking the model to honor
a path.

## 19. Sequencing and parallelism

```
W0.1 (gate)
  └─> W1.1 ─> W1.3 ─> W1.4 ─> W1.5 ─┬─> W1.7
      W1.2 ─┘                W1.6 ──┴─> W1.8
                                        │
                       W2.1 ─> W2.2 ─> W2.3 ─> W2.4 ─> W2.5
                                                 │
                              W3.1 ─> W3.2 ─> W3.3 ─> W3.4
                                                 │
                              W4.1 ─> W4.2 ─> W4.3 ─> W4.4 ─> W4.5
                                                 │
                                       W5.1 ─> W5.2 ─> (W6)
```

- `W1.2` (config) is independent — do it first to unblock quota work.
- `W2.1`–`W2.3` can start once `W1.6` exists; only `W2.4` needs the real
  containment set.
- `W4.2` is mechanical and parallelizable across routes once `W4.1` lands.

## 20. Definition of done (per phase)

| Phase | Done when                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| 0     | Spike result written into §12 with a verdict; ticket updated                                                 |
| 1     | Lease create/resolve/inspect/remove + GC covered by unit tests; zero user-visible change; `verify` green      |
| 2     | Write inside a lease auto-allows; outside every root still prompts; mid-session lease covered; `verify` green |
| 3     | Agent creates/uses/removes a worktree end-to-end in `dev:isolated`; group disable-able; `verify` green        |
| 4     | Switcher lists primary + leases with correct per-tree diffs at mobile and desktop widths; e2e green           |
| 5     | Lease work reaches a branch the human can merge; no half-merged state reachable by an agent                   |
