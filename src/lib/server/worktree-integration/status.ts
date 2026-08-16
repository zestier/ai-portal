import { resolve } from 'node:path';
import {
	countLines,
	git,
	gitOk,
	parseWorktreeList,
	realpathOrResolve,
	WorktreeIntegrationError
} from './common';

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
export async function conflictedPaths(cwd: string): Promise<string[]> {
	const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (result.code !== 0) return [];
	return result.stdout.split('\n').filter(Boolean);
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
