import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { getLease, mergeLease } from '$lib/server/leases';
import { WorktreeIntegrationError } from '$lib/server/worktree-integration';
import { WorkspaceUnavailableError } from '$lib/server/workdir';
import { parseBody } from '$lib/server/validate';
import { audit } from '$lib/server/audit';

const Body = z
	.object({
		direction: z.enum(['to-source', 'from-source']).optional(),
		allowMergeCommit: z.boolean().optional(),
		onConflict: z.enum(['abort', 'keep']).optional()
	})
	.strict();

/**
 * Merge a worktree lease with the conversation holding it.
 *
 * The human counterpart to the `worktree_merge` tool. An orchestrator normally
 * collects its own sub-agents' work, but a run can end (or be abandoned)
 * without doing so, and the alternative is leaving the user to find and merge
 * `portal/lease/<ulid>--<label>` by hand.
 */
export const POST: RequestHandler = async ({ params, locals, request, getClientAddress }) => {
	const conversation = authorizeConversation(params.id, locals.userId);
	const lease = getLease(params.leaseId, conversation.userId);
	// Same flat 404 for "no such lease" and "not this conversation's lease".
	if (!lease || lease.heldByConversationId !== conversation.id) throw error(404);
	const body = await parseBody(request, Body);

	try {
		// `exactOptionalPropertyTypes` is on, so spread only the keys actually
		// supplied rather than passing explicit `undefined`s.
		const result = await mergeLease(lease, conversation, {
			...(body.direction ? { direction: body.direction } : {}),
			...(body.allowMergeCommit === undefined ? {} : { allowMergeCommit: body.allowMergeCommit }),
			...(body.onConflict ? { onConflict: body.onConflict } : {})
		});
		audit({
			event_type: 'worktree_merge',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: lease.path,
			outcome: 'success',
			detail: {
				conversationId: conversation.id,
				leaseId: lease.id,
				direction: result.direction,
				merged: result.merged,
				into: result.into
			}
		});
		return json({ merge: result });
	} catch (cause) {
		if (cause instanceof WorktreeIntegrationError) {
			audit({
				event_type: 'worktree_merge',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: lease.path,
				outcome: 'failure',
				detail: { conversationId: conversation.id, leaseId: lease.id, code: cause.code }
			});
			// Every guard here is a precondition the caller can act on (commit
			// first, sync first, resolve a conflict) rather than a server fault.
			throw error(cause.code === 'git_failed' ? 500 : 409, {
				message: cause.message,
				code: cause.code,
				detail: cause.detail
			} as App.Error);
		}
		if (cause instanceof WorkspaceUnavailableError) {
			throw error(409, { message: cause.message, code: cause.code });
		}
		throw cause;
	}
};
