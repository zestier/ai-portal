// The optional `worktree: <leaseId>` selector shared by every tool group that
// can act on a directory.
//
// It lives here rather than in `./git` because two groups need the SAME
// resolution rules: the git tools (read a lease, commit into a lease) and the
// filesystem tools (mkdir/move/trash inside a lease). Duplicating the lease
// lookup would be a security-relevant divergence — the held-by-this-conversation
// check below is the whole reason the selector cannot be used to reach an
// arbitrary path — so both import this one implementation.

import { z } from 'zod';
import { getLease, resolveLeaseWorkspace, touchLease } from '../leases';
import { WorkspaceUnavailableError } from '../workdir';
import { err, type ToolResult } from './types';

/**
 * Optional lease selector accepted by the directory-scoped tools.
 *
 * Without it the read tools could only ever describe the conversation's own
 * workspace, which leaves an orchestrator blind to the worktrees it handed to
 * sub-agents: it could create a worktree and merge it back, but not look inside
 * it. The write tools take the same selector for the mirror-image reason — a
 * sub-agent given only a lease path could edit there but never commit (or
 * mkdir, or delete), so its work stayed unmergeable and was silently thrown
 * away at merge time. Shell `git`/`mkdir`/`rm` are not a fallback: this portal
 * deliberately does not seed those shell grants.
 */
export const WorktreeSelector = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.transform((value) => (value === '.' ? undefined : value))
	.optional();

export const WORKTREE_PARAM = {
	type: 'string',
	description:
		"Worktree id held by this conversation (from worktree_create / worktree_list). Omit or use `.` for this conversation's workspace."
} as const;

export const WORKTREE_COMMIT_PARAM = {
	type: 'string',
	description:
		"Worktree id to commit in (from worktree_create / worktree_list). Omit or use `.` for this conversation's workspace. Paths resolve relative to the selected workspace."
} as const;

export const WORKTREE_WRITE_PARAM = {
	type: 'string',
	description:
		"Worktree id to act in (from worktree_create / worktree_list). Omit or use `.` for this conversation's workspace. Paths resolve relative to it."
} as const;

/**
 * Session context needed to resolve the selector. Optional at the call sites so
 * callers that only have a directory (tests, one-off tooling) keep working —
 * without it the selector is rejected rather than silently ignored.
 */
export interface WorktreeToolContext {
	userId: string;
	conversationId: string;
}

/** Either the directory to act in, or the error envelope to return instead. */
export type TreeSelection =
	| { cwd: string; error?: undefined }
	| { cwd?: undefined; error: ToolResult };

/**
 * Resolve a lease id to its checkout directory, WITHOUT marking the lease used.
 *
 * The lease must be held by THIS conversation, matching `worktree_status` /
 * `worktree_merge`. That check is what keeps the selector from becoming a way
 * to reach an arbitrary path: lease paths are portal-created checkouts of the
 * conversation's own repository, and are already inside the roots
 * `workspaceRootsFor` grants it.
 *
 * The stored path is never trusted on its own either — `resolveLeaseWorkspace`
 * re-derives it from (userId, leaseId) and checks containment under
 * WORKTREE_ROOT, failing closed. That matters most on the write path: a
 * tampered or replaced row must not be able to steer a write somewhere the
 * approval dialog never named.
 *
 * Returns null for any unresolvable selector so read-only callers (notably
 * `derivePermissionRequest`, which must not mutate anything) can fail closed.
 */
export function resolveWorktreeDir(
	leaseId: string,
	ctx: WorktreeToolContext | undefined
): string | null {
	if (!ctx) return null;
	const lease = getLease(leaseId, ctx.userId);
	if (!lease || lease.heldByConversationId !== ctx.conversationId) return null;
	try {
		return resolveLeaseWorkspace(lease);
	} catch (cause) {
		if (!(cause instanceof WorkspaceUnavailableError)) throw cause;
		return null;
	}
}

/**
 * Build the per-tool `treeFor(leaseId)` resolver: no selector means the
 * conversation's own `cwd`, a selector means the lease's checkout. Unlike
 * `resolveWorktreeDir` this distinguishes the failure modes so the model is told
 * WHY a selector was refused, and touches the lease on success — reading or
 * writing a worktree is using it, and without that the idle reaper could collect
 * a lease an orchestrator is actively driving.
 */
export function createTreeResolver(
	cwd: string,
	ctx: WorktreeToolContext | undefined
): (leaseId: string | undefined) => TreeSelection {
	return (leaseId) => {
		if (!leaseId) return { cwd };
		if (!ctx) {
			return {
				error: err('worktree selection is not available in this session', {
					code: 'worktree_unavailable'
				})
			};
		}
		const lease = getLease(leaseId, ctx.userId);
		if (!lease || lease.heldByConversationId !== ctx.conversationId) {
			return {
				error: err(`no worktree with id ${leaseId} in this conversation`, {
					code: 'lease_not_found'
				})
			};
		}
		let path: string;
		try {
			path = resolveLeaseWorkspace(lease);
		} catch (cause) {
			if (!(cause instanceof WorkspaceUnavailableError)) throw cause;
			return {
				error: err(`worktree ${leaseId} is no longer available: ${cause.message}`, {
					code: 'worktree_unavailable'
				})
			};
		}
		touchLease(lease.id);
		return { cwd: path };
	};
}
