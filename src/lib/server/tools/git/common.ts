import { z } from 'zod';
import { worktreeIntegrationStatus, WorktreeIntegrationError } from '../../worktree-integration';
import type { DiffTarget, MergeState } from '../../git';
import { err } from '../types';
import type { WorktreeToolContext } from '../worktree-selector';
import {
	mergeInProgressFollowUpHint,
	sequencerFollowUpHint,
	unmergedPathsFollowUpHint
} from '../follow-up-hints';

export const TargetKind = z.enum([
	'worktree-vs-head',
	'worktree-vs-index',
	'index-vs-head',
	'commit',
	'commit-vs-parent'
]);
export const DiffOutput = z.enum(['patch', 'stat', 'numstat', 'name-only', 'name-status']);

/**
 * Session context needed to resolve the optional `worktree` selector. Optional
 * so callers that only have a directory (tests, one-off tooling) keep working —
 * without it the selector is rejected rather than silently ignored.
 */
export type GitToolContext = WorktreeToolContext;

/**
 * The `git_status` nudge for a tree that cannot simply be committed: mid-merge
 * (finish or abort), mid-sequencer (a rebase/cherry-pick the portal cannot
 * continue), or merely holding unmerged paths (finish only). Absent for an
 * ordinary tree, so its presence is the signal.
 *
 * The sequencer case is checked first: a conflicted rebase also has unmerged
 * paths, and the generic "resolve and commit" advice would imply the commit
 * finishes an operation it does not finish.
 */
export function mergeStatusFollowUpHint(
	merge: MergeState,
	leaseId: string | undefined
): { followUpHint: string } | undefined {
	if (merge.sequencer) return { followUpHint: sequencerFollowUpHint(merge.sequencer, leaseId) };
	if (merge.inProgress) return { followUpHint: mergeInProgressFollowUpHint(leaseId) };
	if (merge.conflictedPaths.length > 0) {
		return { followUpHint: unmergedPathsFollowUpHint(leaseId) };
	}
	return undefined;
}

/** Normalize an integration failure into the tool envelope, preserving its code. */
export function toolErrorFor(cause: unknown) {
	if (cause instanceof WorktreeIntegrationError) {
		return err(cause.message, { code: cause.code, details: cause.detail });
	}
	throw cause;
}

export async function isLinkedWorktree(cwd: string): Promise<boolean> {
	try {
		return (await worktreeIntegrationStatus(cwd)).isLinkedWorktree;
	} catch {
		return false;
	}
}

export function toDiffTarget(
	kind: z.infer<typeof TargetKind>,
	sha: string | undefined
): DiffTarget {
	switch (kind) {
		case 'worktree-vs-head':
		case 'worktree-vs-index':
		case 'index-vs-head':
			return { kind };
		case 'commit':
		case 'commit-vs-parent':
			if (!sha) throw new Error(`sha is required for git_diff target=${kind}`);
			return { kind, sha };
	}
}

export function requiresSha(kind: z.infer<typeof TargetKind>): boolean {
	return kind === 'commit' || kind === 'commit-vs-parent';
}
