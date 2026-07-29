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

import { resolve } from 'node:path';
import { runGitRaw, type GitRunResult } from './git';

const TIMEOUT_MS = 20_000;

export type WorktreeIntegrationErrorCode =
	| 'not_git_repository'
	| 'not_a_worktree'
	| 'detached_head'
	| 'upstream_detached'
	| 'worktree_dirty'
	| 'upstream_dirty'
	| 'not_fast_forwardable'
	| 'merge_conflict'
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
	/** HEAD of the receiving tree after the merge. */
	headSha: string;
	/** Status recomputed after the merge. */
	status: WorktreeIntegrationStatus;
}

async function git(cwd: string, args: string[]): Promise<GitRunResult> {
	return runGitRaw(args, { cwd, timeoutMs: TIMEOUT_MS });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
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
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated and
 * the FIRST one is always the main worktree, which is the property this module
 * relies on to identify "upstream".
 */
function parseWorktreeList(stdout: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | null = null;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			current = { path: line.slice('worktree '.length).trim(), branch: null };
			records.push(current);
		} else if (line.startsWith('branch ') && current) {
			current.branch = line
				.slice('branch '.length)
				.trim()
				.replace(/^refs\/heads\//, '');
		}
	}
	return records;
}

function countLines(text: string): number {
	return text ? text.split('\n').filter(Boolean).length : 0;
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
 * Describe a tree's position relative to the branch checked out in the
 * repository's main worktree. Cheap enough (a handful of plumbing calls) to run
 * per conversation on a list view, but see the TTL cache in the bulk route.
 */
export async function worktreeIntegrationStatus(cwd: string): Promise<WorktreeIntegrationStatus> {
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
	const upstreamPath = resolve(main.path);
	const isLinkedWorktree = upstreamPath !== path;
	const branch = records.find((r) => resolve(r.path) === path)?.branch ?? null;
	const upstreamBranch = main.branch;

	const [dirty, upstreamDirty] = await Promise.all([
		dirtyCount(path),
		isLinkedWorktree ? dirtyCount(upstreamPath).catch(() => 0) : Promise.resolve(0)
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
	const status = await worktreeIntegrationStatus(cwd);
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

	return opts.direction === 'from-source'
		? mergeFromSource(status as MergeableStatus, opts)
		: mergeToSource(status as MergeableStatus, opts);
}

/** A status already validated by {@link mergeWorktree} to have both branches. */
type MergeableStatus = WorktreeIntegrationStatus & { branch: string; upstreamBranch: string };

async function mergeFromSource(
	status: MergeableStatus,
	opts: MergeWorktreeOptions
): Promise<MergeWorktreeResult> {
	const { branch, upstreamBranch } = status;
	if (status.behind === 0) {
		return finish(status, {
			direction: 'from-source',
			merged: false,
			into: branch,
			from: upstreamBranch,
			path: status.path,
			fastForward: false
		});
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
	return finish(status, {
		direction: 'from-source',
		merged: true,
		into: branch,
		from: upstreamBranch,
		path: status.path,
		// A sync is a fast-forward whenever the worktree had no commits of its own.
		fastForward: status.ahead === 0
	});
}

async function mergeToSource(
	status: MergeableStatus,
	opts: MergeWorktreeOptions
): Promise<MergeWorktreeResult> {
	const { branch, upstreamBranch } = status;
	if (status.ahead === 0) {
		return finish(status, {
			direction: 'to-source',
			merged: false,
			into: upstreamBranch,
			from: branch,
			path: status.upstreamPath,
			fastForward: false
		});
	}
	if (status.upstreamDirtyCount > 0) {
		throw new WorktreeIntegrationError(
			'upstream_dirty',
			`the source checkout has ${status.upstreamDirtyCount} uncommitted change(s); merging into it could entangle them`,
			{ dirtyCount: status.upstreamDirtyCount }
		);
	}
	const allowMergeCommit = opts.allowMergeCommit === true;
	if (status.behind > 0 && !allowMergeCommit) {
		throw new WorktreeIntegrationError(
			'not_fast_forwardable',
			`the source branch has ${status.behind} commit(s) this worktree does not; merge direction "from-source" first, or retry with allowMergeCommit`,
			{ ahead: status.ahead, behind: status.behind }
		);
	}
	const merge = await git(status.upstreamPath, [
		'merge',
		'--no-edit',
		allowMergeCommit ? '--no-ff' : '--ff-only',
		...(allowMergeCommit ? ['-m', `Merge branch '${branch}'`] : []),
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
	return finish(status, {
		direction: 'to-source',
		merged: true,
		into: upstreamBranch,
		from: branch,
		path: status.upstreamPath,
		fastForward: !allowMergeCommit
	});
}

async function finish(
	status: WorktreeIntegrationStatus,
	partial: Omit<MergeWorktreeResult, 'headSha' | 'status'>
): Promise<MergeWorktreeResult> {
	const headSha = await gitOk(partial.path, ['rev-parse', 'HEAD']);
	invalidateIntegrationStatus();
	return { ...partial, headSha, status: await worktreeIntegrationStatus(status.path) };
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
	maxAgeMs: number = DEFAULT_STATUS_TTL_MS
): Promise<WorktreeIntegrationStatus> {
	const key = resolve(cwd);
	const hit = statusCache.get(key);
	if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
	const value = worktreeIntegrationStatus(key);
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
