// Integration ("merge back") for linked git worktrees.
//
// `worktrees.ts` owns the *lifecycle* of a portal-managed worktree — create it,
// inspect it, remove it. This module owns what happens in between: telling a
// worktree's branch apart from the branch it was cut from, and moving commits
// between the two.
//
// Everything here is derived from git itself rather than from
// `managed_worktrees`, for two reasons:
//   - the source checkout can move on (new commits, a different branch) after
//     the row was written, so the row's `base_sha` is a creation-time fact, not
//     a live answer to "where does this work belong?"; and
//   - deriving from `git worktree list` means the same code works for any linked
//     worktree, including ones the portal did not create.
//
// "Upstream" is defined as the branch checked out in the repository's MAIN
// worktree (the first record `git worktree list --porcelain` reports). That is
// the tree a human is looking at, so it is what "merge my session's work back"
// means in practice.

import { join, resolve } from 'node:path';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { formatCommitMessage, runGitRaw, type CommitTrailer, type GitRunResult } from './git';
import { withRepositoryLock } from './repo-lock';

const TIMEOUT_MS = 20_000;
/**
 * Longer budget for the one call here that runs repository hooks (the squash
 * commit). Matches `commitChanges`, whose `pre-commit` can be a whole test
 * suite; the plumbing calls around it stay on the short timeout.
 */
const HOOK_TIMEOUT_MS = 60_000;

export type WorktreeIntegrationErrorCode =
	| 'not_git_repository'
	| 'not_a_worktree'
	| 'detached_head'
	| 'upstream_detached'
	| 'worktree_dirty'
	| 'upstream_dirty'
	| 'not_fast_forwardable'
	| 'merge_conflict'
	| 'squash_not_applicable'
	| 'squash_behind_source'
	| 'invalid_squash_message'
	| 'git_failed';

export class WorktreeIntegrationError extends Error {
	constructor(
		public readonly code: WorktreeIntegrationErrorCode,
		message: string,
		public readonly detail?: {
			stderr?: string;
			dirtyCount?: number;
			conflicts?: string[];
			ahead?: number;
			behind?: number;
		}
	) {
		super(message);
		this.name = 'WorktreeIntegrationError';
	}
}

export interface WorktreeIntegrationStatus {
	/** Absolute path of the tree that was inspected. */
	path: string;
	/** True when `path` is a linked worktree rather than the repository's main one. */
	isLinkedWorktree: boolean;
	/** Branch checked out in `path`, or null when detached. */
	branch: string | null;
	/** Absolute path of the repository's main worktree. */
	upstreamPath: string;
	/**
	 * The repository's git common dir — shared by the main worktree and every
	 * linked worktree. Used as the repository-lock key so merges serialize
	 * against worktree add/remove.
	 */
	gitCommonDir: string;
	/** Branch checked out in the main worktree, or null when detached. */
	upstreamBranch: string | null;
	/** Commits on `branch` that `upstreamBranch` does not have. */
	ahead: number;
	/** Commits on `upstreamBranch` that `branch` does not have. */
	behind: number;
	/** Uncommitted (including untracked) entries in `path`. */
	dirtyCount: number;
	/** Uncommitted (including untracked) entries in the main worktree. */
	upstreamDirtyCount: number;
	/**
	 * True when this tree holds work the upstream branch does not: either commits
	 * that were never merged, or uncommitted changes that were never committed.
	 * This is the single flag the UI badges on.
	 */
	unmerged: boolean;
}

export type MergeDirection = 'from-source' | 'to-source';

export interface MergeWorktreeOptions {
	direction: MergeDirection;
	/**
	 * `to-source` only. When false (default) the integration must fast-forward,
	 * which keeps the source checkout linear and guarantees it can never end up
	 * mid-merge. When true a `--no-ff` merge commit is allowed.
	 */
	allowMergeCommit?: boolean;
	/**
	 * `from-source` only. `abort` (default) rolls a conflicted merge back so no
	 * half-merged state is left behind; `keep` leaves the conflict in the
	 * *isolated* worktree for the agent to resolve and commit. Never applies to
	 * `to-source` — the shared source checkout is always rolled back.
	 */
	onConflict?: 'abort' | 'keep';
	/**
	 * Tree to merge with instead of the repository's main worktree. Used for
	 * worktree leases, whose counterpart is the conversation holding them. See
	 * {@link WorktreeIntegrationStatusOptions.upstreamPath}.
	 */
	upstreamPath?: string;
	/**
	 * `to-source` only. Collapse the worktree's commits into a single commit
	 * *on the worktree's own branch* before merging, so the source checkout
	 * gains exactly one commit per unit of work.
	 *
	 * The squash happens in-branch (`reset --soft` to the source branch's tip,
	 * then commit) rather than as `git merge --squash` into the source: that
	 * keeps the branch ref pointing at the squashed commit, so `ahead` /
	 * `unmerged` still read correctly afterwards. A `merge --squash` would leave
	 * the branch permanently reporting unmerged work.
	 *
	 * Requires the worktree to be level with the source branch (`behind === 0`),
	 * because squashing onto a stale base would reverse the commits the source
	 * has and this branch does not — sync with `from-source` first. Since that
	 * guarantees the follow-up merge fast-forwards, `allowMergeCommit` has no
	 * effect when squashing.
	 */
	squash?: SquashMessage;
}

/**
 * Message for the squash commit. Mirrors `git_commit`'s shape: the subject is
 * required rather than generated, so the collapsed commit can name the ticket
 * the work belongs to.
 */
export interface SquashMessage {
	subject: string;
	body?: string | undefined;
	trailers?: CommitTrailer[] | undefined;
}

export interface MergeWorktreeResult {
	direction: MergeDirection;
	/** False when there was nothing to do (already up to date). */
	merged: boolean;
	/** Branch that received the commits. */
	into: string;
	/** Branch the commits came from. */
	from: string;
	/** Tree the merge ran in. */
	path: string;
	/** True when the merge was a fast-forward rather than a merge commit. */
	fastForward: boolean;
	/**
	 * Number of commits collapsed into one by `squash` before the merge. Absent
	 * when no squash ran — either it was not asked for, or the branch's tree
	 * already matched the source's, so there was nothing to collapse.
	 */
	squashedCommits?: number;
	/** HEAD of the receiving tree after the merge. */
	headSha: string;
	/** Status recomputed after the merge. */
	status: WorktreeIntegrationStatus;
}

async function git(cwd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<GitRunResult> {
	return runGitRaw(args, { cwd, timeoutMs });
}

async function gitOk(cwd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
	const result = await git(cwd, args, timeoutMs);
	if (result.code !== 0) {
		throw new WorktreeIntegrationError(
			'git_failed',
			result.timedOut ? `git ${args[0]} timed out` : `git ${args[0]} failed`,
			{ stderr: result.stderr.trim() }
		);
	}
	return result.stdout.trim();
}

interface WorktreeRecord {
	path: string;
	branch: string | null;
	/** Commit checked out in the tree, or null for a bare repository. */
	head: string | null;
	/** True for the record describing a bare repository (it has no working tree). */
	bare: boolean;
	/** True when HEAD points at a commit rather than a branch. */
	detached: boolean;
	/** Reason given to `git worktree lock`, '' when locked without one, null when unlocked. */
	lockedReason: string | null;
	/** Why git considers the record removable (e.g. its directory is gone), else null. */
	prunableReason: string | null;
}

/** `<keyword>` alone or `<keyword> <value>`; returns the value ('' when bare). */
function porcelainValue(line: string, keyword: string): string | null {
	if (line === keyword) return '';
	if (line.startsWith(`${keyword} `)) return line.slice(keyword.length + 1).trim();
	return null;
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * the FIRST one is always the main worktree, which is the property this module
 * relies on to identify "upstream".
 */
function parseWorktreeList(stdout: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | null = null;
	for (const raw of stdout.split('\n')) {
		const line = raw.trimEnd();
		if (line.startsWith('worktree ')) {
			current = {
				path: line.slice('worktree '.length).trim(),
				branch: null,
				head: null,
				bare: false,
				detached: false,
				lockedReason: null,
				prunableReason: null
			};
			records.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith('branch ')) {
			current.branch = line
				.slice('branch '.length)
				.trim()
				.replace(/^refs\/heads\//, '');
		} else if (line.startsWith('HEAD ')) {
			current.head = line.slice('HEAD '.length).trim();
		} else if (line === 'bare') {
			current.bare = true;
		} else if (line === 'detached') {
			current.detached = true;
		} else {
			const locked = porcelainValue(line, 'locked');
			if (locked !== null) {
				current.lockedReason = locked;
				continue;
			}
			const prunable = porcelainValue(line, 'prunable');
			if (prunable !== null) current.prunableReason = prunable;
		}
	}
	return records;
}

/** One tree in {@link listWorktrees}. */
export interface WorktreeListEntry {
	/** Absolute path of the tree (as git reports it). */
	path: string;
	/** True for the repository's main checkout — always exactly one entry. */
	isMain: boolean;
	/** True for the tree the query ran in. */
	isCurrent: boolean;
	/** Branch checked out there, or null when detached or bare. */
	branch: string | null;
	/** Commit checked out there, or null for a bare repository. */
	head: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	/** Lock reason, '' when locked without one, null when unlocked. */
	lockedReason: string | null;
	/** True when git considers the record removable (its directory is gone). */
	prunable: boolean;
	prunableReason: string | null;
	/**
	 * Uncommitted (including untracked) entries. Only populated when
	 * `includeDirty` is set, and null for trees that cannot be inspected (bare,
	 * prunable, or unreadable).
	 */
	dirtyCount: number | null;
}

export interface ListWorktreesResult {
	/** Absolute path of the repository's main worktree. */
	mainPath: string;
	/** Tree the query ran in, or null when it was run from a bare repository. */
	currentPath: string | null;
	worktrees: WorktreeListEntry[];
}

export interface ListWorktreesOptions {
	/**
	 * Also count uncommitted changes in each tree. Off by default: it costs one
	 * `git status` per worktree, while the listing itself is a single call.
	 */
	includeDirty?: boolean;
}

/**
 * Enumerate every worktree of the repository containing `cwd`.
 *
 * Derived from `git worktree list`, not from `managed_worktrees`, so it sees
 * trees the portal did not create — the human's own, and those belonging to
 * other conversations. That is the difference from `worktree_list`, which
 * reports portal-managed leases held by one conversation.
 */
export async function listWorktrees(
	cwd: string,
	opts: ListWorktreesOptions = {}
): Promise<ListWorktreesResult> {
	const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
	if (inside.code !== 0) {
		throw new WorktreeIntegrationError('not_git_repository', 'not a git repository');
	}
	const currentPath =
		inside.stdout.trim() === 'true'
			? resolve(await gitOk(cwd, ['rev-parse', '--show-toplevel']))
			: null;
	const records = parseWorktreeList(await gitOk(cwd, ['worktree', 'list', '--porcelain']));
	const main = records[0];
	if (!main) {
		throw new WorktreeIntegrationError('git_failed', 'could not determine the main worktree');
	}
	const worktrees = await Promise.all(
		records.map(async (record): Promise<WorktreeListEntry> => {
			const path = resolve(record.path);
			// A bare or already-gone tree has nothing to run `git status` in.
			const inspectable = !record.bare && record.prunableReason === null;
			const dirty =
				opts.includeDirty && inspectable ? await dirtyCount(path).catch(() => null) : null;
			return {
				path,
				isMain: record === main,
				isCurrent: currentPath !== null && path === currentPath,
				branch: record.branch,
				head: record.head,
				detached: record.detached,
				bare: record.bare,
				locked: record.lockedReason !== null,
				lockedReason: record.lockedReason,
				prunable: record.prunableReason !== null,
				prunableReason: record.prunableReason,
				dirtyCount: dirty
			};
		})
	);
	return { mainPath: resolve(main.path), currentPath, worktrees };
}

function countLines(text: string): number {
	return text ? text.split('\n').filter(Boolean).length : 0;
}

/** Realpath when possible, lexical resolve otherwise (mirrors `worktrees.ts`). */
function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Ahead/behind between two branches, as `git rev-list --left-right --count`
 * reports it: left = commits only on `upstream`, right = commits only on
 * `branch`.
 */
async function aheadBehind(
	cwd: string,
	branch: string,
	upstream: string
): Promise<{ ahead: number; behind: number }> {
	const result = await git(cwd, [
		'rev-list',
		'--left-right',
		'--count',
		`refs/heads/${upstream}...refs/heads/${branch}`
	]);
	if (result.code !== 0) return { ahead: 0, behind: 0 };
	const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
	return {
		ahead: Number.isFinite(ahead) ? ahead : 0,
		behind: Number.isFinite(behind) ? behind : 0
	};
}

async function dirtyCount(cwd: string): Promise<number> {
	return countLines(await gitOk(cwd, ['status', '--porcelain=v1', '-uall']));
}

/**
 * Options for {@link worktreeIntegrationStatus}.
 */
export interface WorktreeIntegrationStatusOptions {
	/**
	 * Tree to treat as "upstream" instead of the repository's main worktree.
	 *
	 * Exists for worktree *leases*, whose counterpart is the conversation that
	 * holds them rather than the repository's main checkout: several sub-agents
	 * work in parallel leases off one conversation, and their results should
	 * gather into that conversation's branch to be reviewed together before any
	 * of it reaches the shared tree.
	 *
	 * `isLinkedWorktree` is deliberately still computed against the real main
	 * worktree, so it keeps meaning "is this a linked worktree of this
	 * repository" rather than "does this differ from the target".
	 */
	upstreamPath?: string;
}

/**
 * Describe a tree's position relative to the branch checked out in the
 * repository's main worktree (or in `opts.upstreamPath`). Cheap enough (a
 * handful of plumbing calls) to run per conversation on a list view, but see
 * the TTL cache in the bulk route.
 */
export async function worktreeIntegrationStatus(
	cwd: string,
	opts: WorktreeIntegrationStatusOptions = {}
): Promise<WorktreeIntegrationStatus> {
	const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
	if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
		throw new WorktreeIntegrationError('not_git_repository', 'not a git repository');
	}
	const path = resolve(await gitOk(cwd, ['rev-parse', '--show-toplevel']));
	const records = parseWorktreeList(await gitOk(cwd, ['worktree', 'list', '--porcelain']));
	const main = records[0];
	if (!main) {
		throw new WorktreeIntegrationError('git_failed', 'could not determine the main worktree');
	}
	// Containment is judged against the real main worktree even when a different
	// tree is the merge target.
	const isLinkedWorktree = resolve(main.path) !== path;
	const requestedUpstream = opts.upstreamPath ? resolve(opts.upstreamPath) : null;
	const upstreamRecord =
		requestedUpstream === null
			? main
			: (records.find((r) => resolve(r.path) === requestedUpstream) ?? null);
	if (!upstreamRecord) {
		throw new WorktreeIntegrationError(
			'not_a_worktree',
			'the requested upstream is not a worktree of this repository'
		);
	}
	const upstreamPath = resolve(upstreamRecord.path);
	const branch = records.find((r) => resolve(r.path) === path)?.branch ?? null;
	const upstreamBranch = upstreamRecord.branch;
	// Resolved through realpath so it matches the key `worktrees.ts` locks on
	// (which realpaths too) — an unresolved symlink here would silently produce a
	// second, non-excluding lock key.
	const gitCommonDir = realpathOrResolve(
		await gitOk(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	);

	const [dirty, upstreamDirty] = await Promise.all([
		dirtyCount(path),
		upstreamPath !== path ? dirtyCount(upstreamPath).catch(() => 0) : Promise.resolve(0)
	]);
	const counts =
		branch && upstreamBranch && branch !== upstreamBranch
			? await aheadBehind(path, branch, upstreamBranch)
			: { ahead: 0, behind: 0 };

	return {
		path,
		isLinkedWorktree,
		branch,
		upstreamPath,
		gitCommonDir,
		upstreamBranch,
		ahead: counts.ahead,
		behind: counts.behind,
		dirtyCount: dirty,
		upstreamDirtyCount: upstreamDirty,
		unmerged: isLinkedWorktree && (counts.ahead > 0 || dirty > 0)
	};
}

/** Paths git left in a conflicted state after a failed merge. */
async function conflictedPaths(cwd: string): Promise<string[]> {
	const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (result.code !== 0) return [];
	return result.stdout.split('\n').filter(Boolean);
}

/**
 * Move commits between a linked worktree's branch and the branch checked out in
 * the repository's main worktree.
 *
 * The two directions are deliberately asymmetric. `from-source` may leave a
 * conflict in place (opt-in) because the worktree is isolated — that is where an
 * agent is *supposed* to resolve it. `to-source` never does: the source checkout
 * is shared with the human, so a conflict there is always rolled back and
 * reported, and by default the integration must fast-forward so the source tree
 * cannot even briefly be mid-merge.
 */
export async function mergeWorktree(
	cwd: string,
	opts: MergeWorktreeOptions
): Promise<MergeWorktreeResult> {
	// Resolve the lock key first, then re-read the status *inside* the lock. The
	// guards below are a check-then-act on shared state (both trees' dirty counts
	// and ahead/behind), so evaluating them against a status read before the lock
	// was held would let a concurrent merge or worktree removal invalidate them
	// between the check and the merge.
	const key = (await worktreeIntegrationStatus(cwd, opts)).gitCommonDir;
	return withRepositoryLock(key, async () => {
		const status = await worktreeIntegrationStatus(cwd, opts);
		if (!status.isLinkedWorktree) {
			throw new WorktreeIntegrationError(
				'not_a_worktree',
				'this workspace is the repository’s main checkout, not a linked worktree'
			);
		}
		if (!status.branch) {
			throw new WorktreeIntegrationError('detached_head', 'the worktree has a detached HEAD');
		}
		if (!status.upstreamBranch) {
			throw new WorktreeIntegrationError(
				'upstream_detached',
				'the source checkout has a detached HEAD, so there is no upstream branch to merge with'
			);
		}
		// Uncommitted work in the worktree is never safe to merge in either
		// direction: it would be clobbered by an incoming merge, and it silently
		// would not be part of an outgoing one.
		if (status.dirtyCount > 0) {
			throw new WorktreeIntegrationError(
				'worktree_dirty',
				'commit or discard the worktree’s uncommitted changes first',
				{ dirtyCount: status.dirtyCount }
			);
		}

		if (opts.squash && opts.direction !== 'to-source') {
			throw new WorktreeIntegrationError(
				'squash_not_applicable',
				'squash applies to direction "to-source" only'
			);
		}

		return opts.direction === 'from-source'
			? mergeFromSource(status as MergeableStatus, opts)
			: mergeToSource(status as MergeableStatus, opts);
	});
}

/** A status already validated by {@link mergeWorktree} to have both branches. */
type MergeableStatus = WorktreeIntegrationStatus & { branch: string; upstreamBranch: string };

async function mergeFromSource(
	status: MergeableStatus,
	opts: MergeWorktreeOptions
): Promise<MergeWorktreeResult> {
	const { branch, upstreamBranch } = status;
	if (status.behind === 0) {
		return finish(
			status,
			{
				direction: 'from-source',
				merged: false,
				into: branch,
				from: upstreamBranch,
				path: status.path,
				fastForward: false
			},
			opts
		);
	}
	const merge = await git(status.path, [
		'merge',
		'--no-edit',
		'-m',
		`Merge branch '${upstreamBranch}' into ${branch}`,
		`refs/heads/${upstreamBranch}`
	]);
	if (merge.code !== 0) {
		const conflicts = await conflictedPaths(status.path);
		if (conflicts.length === 0 || opts.onConflict !== 'keep') {
			await git(status.path, ['merge', '--abort']);
		}
		throw new WorktreeIntegrationError(
			conflicts.length > 0 ? 'merge_conflict' : 'git_failed',
			conflicts.length > 0
				? opts.onConflict === 'keep'
					? `merge left ${conflicts.length} conflicted file(s) in the worktree to resolve and commit`
					: `merge conflicted on ${conflicts.length} file(s) and was rolled back`
				: 'git merge failed',
			{ stderr: merge.stderr.trim(), conflicts }
		);
	}
	return finish(
		status,
		{
			direction: 'from-source',
			merged: true,
			into: branch,
			from: upstreamBranch,
			path: status.path,
			// A sync is a fast-forward whenever the worktree had no commits of its own.
			fastForward: status.ahead === 0
		},
		opts
	);
}

async function mergeToSource(
	status: MergeableStatus,
	opts: MergeWorktreeOptions
): Promise<MergeWorktreeResult> {
	const { branch, upstreamBranch } = status;
	if (status.ahead === 0) {
		return finish(
			status,
			{
				direction: 'to-source',
				merged: false,
				into: upstreamBranch,
				from: branch,
				path: status.upstreamPath,
				fastForward: false
			},
			opts
		);
	}
	if (status.upstreamDirtyCount > 0) {
		throw new WorktreeIntegrationError(
			'upstream_dirty',
			`the source checkout has ${status.upstreamDirtyCount} uncommitted change(s); merging into it could entangle them`,
			{ dirtyCount: status.upstreamDirtyCount }
		);
	}
	const allowMergeCommit = opts.allowMergeCommit === true;
	if (status.behind > 0 && opts.squash) {
		throw new WorktreeIntegrationError(
			'squash_behind_source',
			`the source branch has ${status.behind} commit(s) this worktree does not, so squashing onto it would revert them; merge direction "from-source" first, then retry the squash`,
			{ ahead: status.ahead, behind: status.behind }
		);
	}
	if (status.behind > 0 && !allowMergeCommit) {
		throw new WorktreeIntegrationError(
			'not_fast_forwardable',
			`the source branch has ${status.behind} commit(s) this worktree does not; merge direction "from-source" first, or retry with allowMergeCommit`,
			{ ahead: status.ahead, behind: status.behind }
		);
	}
	// Squashing guarantees `behind === 0`, so the merge below always
	// fast-forwards; a merge commit on top of that would reintroduce exactly the
	// noise the squash was asked for.
	//
	// A failure of that merge deliberately leaves the branch squashed rather than
	// restoring it: the squashed commit holds the identical tree, so nothing is
	// lost, and the retry is the same call again (which re-squashes the one
	// commit). Undoing it would move a ref for no gain while the caller is
	// already handling an error.
	const squashedCommits = opts.squash ? await squashBranch(status, opts.squash) : null;
	const mergeCommit = allowMergeCommit && !opts.squash;
	const merge = await git(status.upstreamPath, [
		'merge',
		'--no-edit',
		mergeCommit ? '--no-ff' : '--ff-only',
		...(mergeCommit ? ['-m', `Merge branch '${branch}'`] : []),
		`refs/heads/${branch}`
	]);
	if (merge.code !== 0) {
		// Always roll the shared checkout back, whatever the caller asked for.
		const conflicts = await conflictedPaths(status.upstreamPath);
		await git(status.upstreamPath, ['merge', '--abort']);
		throw new WorktreeIntegrationError(
			conflicts.length > 0 ? 'merge_conflict' : 'git_failed',
			conflicts.length > 0
				? `merge conflicted on ${conflicts.length} file(s) in the source checkout and was rolled back`
				: 'git merge failed',
			{ stderr: merge.stderr.trim(), conflicts }
		);
	}
	return finish(
		status,
		{
			direction: 'to-source',
			merged: true,
			into: upstreamBranch,
			from: branch,
			path: status.upstreamPath,
			fastForward: !mergeCommit,
			...(squashedCommits === null ? {} : { squashedCommits })
		},
		opts
	);
}

/**
 * Collapse a worktree branch's commits into one, in place.
 *
 * `reset --soft` to the source branch's tip and commit: the branch ref ends up
 * one commit ahead of the source with the same tree it had, which is exactly
 * what the following `--ff-only` merge wants. Squashing onto the source's TIP
 * (rather than the merge base) is what absorbs any merge commit an earlier
 * `from-source` sync left behind, so nothing of it reaches the source checkout.
 *
 * Returns the number of commits collapsed, or null when the branch's tree
 * already matches the source's — squashing that to an empty commit would add
 * noise, so the caller's plain fast-forward is left to handle it.
 *
 * Only ever called for a linked worktree's own branch, never the source branch,
 * and only with a clean tree and `behind === 0` (both checked by the caller):
 * this rewrites history, so it must not run anywhere it could be shared.
 */
async function squashBranch(
	status: MergeableStatus,
	squash: SquashMessage
): Promise<number | null> {
	const upstreamRef = `refs/heads/${status.upstreamBranch}`;
	// Validate (and render) the message BEFORE touching any ref, so a bad
	// subject cannot leave the branch reset with nothing committed.
	let message: string;
	try {
		message = formatCommitMessage(squash);
	} catch (cause) {
		throw new WorktreeIntegrationError(
			'invalid_squash_message',
			cause instanceof Error ? cause.message : 'invalid squash commit message'
		);
	}
	const diff = await git(status.path, ['diff', '--quiet', upstreamRef, 'HEAD']);
	if (diff.code === 0) return null;
	if (diff.code !== 1) {
		throw new WorktreeIntegrationError(
			'git_failed',
			'could not compare the branch with the source',
			{
				stderr: diff.stderr.trim()
			}
		);
	}
	const headBefore = await gitOk(status.path, ['rev-parse', 'HEAD']);
	// The message file is written BEFORE the branch is moved: everything that can
	// fail without a rollback (temp dir, disk) must happen while the branch is
	// still where the caller left it. Only the reset/commit pair below is
	// recoverable, and only that pair is inside the try.
	const messageDir = mkdtempSync(join(tmpdir(), 'portal-worktree-squash-'));
	try {
		const messagePath = join(messageDir, 'message.txt');
		writeFileSync(messagePath, message, 'utf8');
		await gitOk(status.path, ['reset', '--soft', upstreamRef]);
		try {
			// Hooks run, exactly as they do for `git_commit`. `--no-verify` would
			// be tempting — the tree is byte-identical to one the branch already
			// committed, so `pre-commit` has nothing new to check — but the MESSAGE
			// is brand new, and after the squash it is the only message left on the
			// branch. Skipping `commit-msg` would make the squashed commit the one
			// commit reaching the source that never passed the repository's message
			// policy.
			await gitOk(status.path, ['commit', '-F', messagePath], HOOK_TIMEOUT_MS);
		} catch (cause) {
			// Put the branch back where it was; the index and working tree already
			// hold that content, so this restores the pre-squash state exactly.
			await git(status.path, ['reset', '--soft', headBefore]);
			throw cause;
		}
	} finally {
		rmSync(messageDir, { recursive: true, force: true });
	}
	return status.ahead;
}

async function finish(
	status: WorktreeIntegrationStatus,
	partial: Omit<MergeWorktreeResult, 'headSha' | 'status'>,
	opts: WorktreeIntegrationStatusOptions = {}
): Promise<MergeWorktreeResult> {
	const headSha = await gitOk(partial.path, ['rev-parse', 'HEAD']);
	invalidateIntegrationStatus();
	// Re-read against the SAME upstream the merge used, or the caller would get
	// back a status measured against a different branch than the one it merged
	// with.
	return { ...partial, headSha, status: await worktreeIntegrationStatus(status.path, opts) };
}

// ---------- Cached reads ----------
//
// A status costs a handful of git subprocesses. That is fine per conversation,
// but the sidebar asks about every managed worktree at once and polls, so those
// reads share a short-lived cache. Writes (merges) clear it so an action's own
// follow-up read never sees its pre-merge answer.

const DEFAULT_STATUS_TTL_MS = 5_000;
const statusCache = new Map<string, { at: number; value: Promise<WorktreeIntegrationStatus> }>();

export async function cachedWorktreeIntegrationStatus(
	cwd: string,
	maxAgeMs: number = DEFAULT_STATUS_TTL_MS,
	opts: WorktreeIntegrationStatusOptions = {}
): Promise<WorktreeIntegrationStatus> {
	// The upstream is part of the identity of the answer, not just of the query:
	// the same tree measured against two different upstreams has different
	// ahead/behind counts. Keying on the path alone would serve one caller's
	// answer to another. No caller passes an upstream today, but the option
	// exists, so the key accounts for it rather than waiting to be a bug.
	const key = opts.upstreamPath ? `${resolve(cwd)}\0${resolve(opts.upstreamPath)}` : resolve(cwd);
	const hit = statusCache.get(key);
	if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
	const value = worktreeIntegrationStatus(resolve(cwd), opts);
	statusCache.set(key, { at: Date.now(), value });
	// A rejected read must not be cached, or a transient failure sticks for the
	// whole TTL.
	value.catch(() => statusCache.delete(key));
	return value;
}

/**
 * Drop cached statuses. A merge changes both the worktree's and the source
 * checkout's position, and callers don't necessarily know which paths those map
 * to, so this clears the whole (small) map.
 */
export function invalidateIntegrationStatus(): void {
	statusCache.clear();
}
