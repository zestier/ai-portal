import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as pool from '$lib/server/runtime/pool';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { listForConversation as listPendingInteractive } from '$lib/server/runtime/interactive-requests';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { getManagedWorktree } from '$lib/server/db/repos/conversations';
import { removeManagedWorktree, WorktreeError } from '$lib/server/worktrees';
import { removeLeasesForConversation } from '$lib/server/leases';
import { worktreeIntegrationStatus } from '$lib/server/worktree-integration';
import { error } from '@sveltejs/kit';
import { audit } from '$lib/server/audit';

export const GET: RequestHandler = ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	// Surface any in-flight turn so the client can reattach its
	// EventSource on page load without a separate round-trip. Only
	// running turns count — finished-but-still-cached turns are not
	// useful to reattach to (replay then immediate done).
	const turn = getTurn(conv.id);
	const activeTurnId = turn && turn.status === 'running' ? turn.id : null;
	return json({
		conversation: conv,
		messages: messages.listByConversation(conv.id),
		activeTurnId,
		// Outstanding prompts so a refresh / SSE blip can rehydrate the
		// dialog rather than stranding the agent on a request the user can
		// no longer see.
		pendingInteractive: listPendingInteractive(conv.id)
	});
};

const PatchBody = z
	.object({
		title: z.string().min(1).max(200).optional(),
		archived: z.boolean().optional()
	})
	.refine((b) => b.title !== undefined || b.archived !== undefined, {
		message: 'No fields to update'
	});

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, PatchBody);

	if (body.title !== undefined) {
		convs.rename(conv.id, conv.userId, body.title);
	}
	if (body.archived !== undefined) {
		if (body.archived) {
			convs.archive(conv.id, conv.userId);
			await pool.release(conv.id);
		} else {
			convs.unarchive(conv.id, conv.userId);
		}
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals, url, getClientAddress }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	// A provider subprocess may have this directory as its cwd. Dispose it
	// before asking Git to remove the linked worktree.
	await pool.release(conv.id);
	const forced = url.searchParams.get('forceWorktree') === '1';

	// Leases first: they are children of the same repository, and failing after
	// the conversation's own checkout is gone would leave a messier state to
	// reconcile. A dirty lease blocks deletion the same way a dirty primary does.
	const leaseResult = await removeLeasesForConversation(conv.id, conv.userId, { force: forced });
	for (const leaseId of leaseResult.removed) {
		audit({
			event_type: 'worktree_remove',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: leaseId,
			outcome: 'success',
			detail: { conversationId: conv.id, leaseId, forced }
		});
	}
	if (leaseResult.retained.length > 0) {
		for (const { lease } of leaseResult.retained) {
			audit({
				event_type: 'worktree_remove',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: lease.id,
				outcome: 'denied',
				detail: { conversationId: conv.id, leaseId: lease.id, code: 'worktree_dirty' }
			});
		}
		throw error(409, {
			message: 'conversation holds worktrees with uncommitted changes',
			code: 'worktree_dirty',
			// Name the holdouts so the client can offer a precise force prompt
			// instead of an all-or-nothing one.
			leases: leaseResult.retained.map(({ lease, dirtyCount }) => ({
				id: lease.id,
				label: lease.label,
				branch: lease.branch,
				dirtyCount
			}))
		} as App.Error);
	}

	const managed = getManagedWorktree(conv.id, conv.userId);
	if (managed) {
		// Removing the checkout leaves the branch behind, so commits are not
		// destroyed — but the conversation that named them is, which turns them
		// into an orphan branch nobody will look for. Treat that like the dirty
		// case: refuse once, and let the client re-confirm.
		if (!forced) {
			const unmerged = await unmergedCommitCount(managed.path);
			if (unmerged > 0) {
				audit({
					event_type: 'worktree_remove',
					actor_login: locals.user?.githubLogin ?? null,
					actor_ip: getClientAddress(),
					resource: managed.path,
					outcome: 'denied',
					detail: { conversationId: conv.id, code: 'worktree_unmerged', ahead: unmerged }
				});
				throw error(409, {
					message: `this worktree has ${unmerged} commit(s) not merged into the source branch`,
					code: 'worktree_unmerged',
					detail: { ahead: unmerged, branch: managed.branch }
				});
			}
		}
		try {
			await removeManagedWorktree(managed, {
				force: forced,
				owner: { kind: 'conversation', userId: conv.userId, conversationId: conv.id }
			});
		} catch (cause) {
			if (cause instanceof WorktreeError) {
				audit({
					event_type: 'worktree_remove',
					actor_login: locals.user?.githubLogin ?? null,
					actor_ip: getClientAddress(),
					resource: managed.path,
					outcome: cause.code === 'worktree_dirty' ? 'denied' : 'failure',
					detail: { conversationId: conv.id, code: cause.code }
				});
				throw error(cause.code === 'worktree_dirty' ? 409 : 500, {
					message: cause.message,
					code: cause.code
				});
			}
			throw cause;
		}
		audit({
			event_type: 'worktree_remove',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: managed.path,
			outcome: 'success',
			detail: {
				conversationId: conv.id,
				forced: url.searchParams.get('forceWorktree') === '1'
			}
		});
	}
	convs.remove(conv.id, conv.userId);
	return json({ ok: true });
};

/**
 * Commits on the worktree's branch that the source branch doesn't have. A
 * missing/broken checkout returns 0 so a stale worktree stays deletable — the
 * guard exists to prevent surprise, not to strand the user.
 */
async function unmergedCommitCount(path: string): Promise<number> {
	try {
		return (await worktreeIntegrationStatus(path)).ahead;
	} catch {
		return 0;
	}
}
