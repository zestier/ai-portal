import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import {
	createLease,
	inspectLease,
	leaseIntegrationStatus,
	listLeases,
	resolveLeaseWorkspace,
	LeaseQuotaError
} from '$lib/server/leases';
import { WorktreeError } from '$lib/server/worktrees';
import { parseBody } from '$lib/server/validate';
import { audit } from '$lib/server/audit';

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
		let ahead: number | null = null;
		let behind: number | null = null;
		try {
			resolveLeaseWorkspace(lease);
			({ dirtyCount } = await inspectLease(lease));
			const status = await leaseIntegrationStatus(lease, conversation);
			ahead = status.ahead;
			behind = status.behind;
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
			dirtyCount,
			// Commits waiting to be merged back into this conversation, which is
			// what the UI offers a merge action for.
			ahead,
			behind
		});
	}
	return json({ worktrees: leases });
};

const CreateBody = z
	.object({
		label: z.string().trim().min(1).max(33),
		baseRef: z.string().trim().min(1).max(500).optional()
	})
	.strict();

/**
 * Create a lease from outside a turn.
 *
 * Symmetric with the DELETE below: the agent tool is the usual path, but a
 * human needs to be able to set one up too — otherwise the only way to get an
 * isolated checkout is to ask an agent for one, and leases are unmanageable
 * whenever no turn is running.
 *
 * Like the tool, the source repository is NOT an argument; it is derived from
 * the holding conversation, so this cannot be used to reach outside
 * ALLOWED_WORKDIRS.
 */
export const POST: RequestHandler = async ({ params, locals, request, getClientAddress }) => {
	const conversation = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, CreateBody);
	try {
		const lease = await createLease({
			conversation,
			label: body.label,
			...(body.baseRef ? { baseRef: body.baseRef } : {})
		});
		audit({
			event_type: 'worktree_create',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: lease.path,
			outcome: 'success',
			detail: { conversationId: conversation.id, leaseId: lease.id, branch: lease.branch }
		});
		return json({ worktree: lease }, { status: 201 });
	} catch (cause) {
		const code =
			cause instanceof LeaseQuotaError
				? cause.code
				: cause instanceof WorktreeError
					? cause.code
					: null;
		if (code) {
			audit({
				event_type: 'worktree_create',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: conversation.id,
				outcome: 'failure',
				detail: { conversationId: conversation.id, code }
			});
			throw error(code === 'git_failed' ? 500 : 400, {
				message: (cause as Error).message,
				code
			});
		}
		throw cause;
	}
};
