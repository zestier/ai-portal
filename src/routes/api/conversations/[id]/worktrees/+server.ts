import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { inspectLease, listLeases, resolveLeaseWorkspace } from '$lib/server/leases';

/**
 * Worktree leases held by this conversation, for the Files/Changes workspace
 * switcher.
 *
 * A lease whose checkout is missing or unreadable is still listed, with
 * `available: false` and a null dirty count. Hiding it would be worse: the user
 * would see work simply vanish with no indication that a checkout existed.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const conversation = authorizeConversation(params.id, locals.userId);
	const leases = [];
	for (const lease of listLeases(conversation.id, conversation.userId)) {
		let available = true;
		let dirtyCount: number | null = null;
		try {
			resolveLeaseWorkspace(lease);
			({ dirtyCount } = await inspectLease(lease));
		} catch {
			available = false;
		}
		leases.push({
			id: lease.id,
			label: lease.label,
			branch: lease.branch,
			path: lease.path,
			baseSha: lease.baseSha,
			state: lease.state,
			createdAt: lease.createdAt,
			lastUsedAt: lease.lastUsedAt,
			available,
			dirtyCount
		});
	}
	return json({ worktrees: leases });
};
