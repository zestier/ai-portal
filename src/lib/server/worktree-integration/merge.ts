import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { formatCommitMessage, type CommitTrailer } from '../git';
import { withRepositoryLock } from '../repo-lock';
import { git, gitOk, WorktreeIntegrationError, HOOK_TIMEOUT_MS } from './common';
import {
	conflictedPaths,
	worktreeIntegrationStatus,
	invalidateIntegrationStatus,
	type WorktreeIntegrationStatus,
	type WorktreeIntegrationStatusOptions
} from './status';

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

export async function mergeFromSource(
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

export async function mergeToSource(
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
