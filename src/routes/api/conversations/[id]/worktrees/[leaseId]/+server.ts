import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { getLease, removeLease } from '$lib/server/leases';
import { WorktreeError } from '$lib/server/worktrees';
import { audit } from '$lib/server/audit';

/**
 * Drop a worktree lease from the UI.
 *
 * This is the human escape hatch for a lease the agent refused to remove (or
 * never got around to): the agent-facing `worktree_remove` requires the model
 * to act, and an abandoned orchestrator run would otherwise pin its checkouts
 * until the idle reaper's TTL elapses — and never, if they are dirty.
 *
 * Mirrors the agent tool's safety: refuses while the checkout has uncommitted
 * changes unless `?force=1`, and only ever deletes a fully merged branch, so
 * committed work survives under its branch name.
 */
export const DELETE: RequestHandler = async ({ params, locals, url, getClientAddress }) => {
	const conversation = authorizeConversation(params.id, locals.userId);
	const lease = getLease(params.leaseId, conversation.userId);
	// Same flat 404 for "no such lease" and "not this conversation's lease": the
	// endpoint must not confirm that an id exists elsewhere.
	if (!lease || lease.heldByConversationId !== conversation.id) throw error(404);

	const forced = url.searchParams.get('force') === '1';
	try {
		const result = await removeLease(lease, forced ? { force: true } : {});
		audit({
			event_type: 'worktree_remove',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: lease.path,
			outcome: 'success',
			detail: {
				conversationId: conversation.id,
				leaseId: lease.id,
				label: lease.label,
				forced,
				branchDeleted: result.branchDeleted
			}
		});
		return json({ ok: true, branch: result.branch, branchDeleted: result.branchDeleted });
	} catch (cause) {
		if (cause instanceof WorktreeError) {
			audit({
				event_type: 'worktree_remove',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: lease.path,
				outcome: cause.code === 'worktree_dirty' ? 'denied' : 'failure',
				detail: { conversationId: conversation.id, leaseId: lease.id, code: cause.code }
			});
			throw error(cause.code === 'worktree_dirty' ? 409 : 500, {
				message: cause.message,
				code: cause.code
			});
		}
		throw cause;
	}
};
