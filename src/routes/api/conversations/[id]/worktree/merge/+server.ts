import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { parseBody } from '$lib/server/validate';
import { audit } from '$lib/server/audit';
import { mergeWorktree, WorktreeIntegrationError } from '$lib/server/worktree-integration';
import { SquashArg } from '$lib/server/tools/commit-message-args';

const MergeBody = z
	.object({
		direction: z.enum(['from-source', 'to-source']).default('to-source'),
		allowMergeCommit: z.boolean().optional().default(false),
		squash: SquashArg
	})
	.strict();

/**
 * Human-facing counterpart to the `git_worktree_merge` tool, so a worktree
 * session can be integrated from the UI without asking an agent to do it. The
 * safety rules live in the service, so both callers get identical refusals.
 *
 * `onConflict` is deliberately not exposed here: leaving conflict markers behind
 * is only useful to an agent that is about to resolve them.
 */
export const POST: RequestHandler = async ({ params, locals, request, getClientAddress }) => {
	const { conversation, workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const body = await parseBody(request, MergeBody);
	const { squash, ...merge } = body;
	try {
		const result = await mergeWorktree(workdir, {
			...merge,
			...(squash === undefined ? {} : { squash })
		});
		audit({
			event_type: 'worktree_merge',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: workdir,
			outcome: 'success',
			detail: {
				conversationId: conversation.id,
				direction: result.direction,
				merged: result.merged,
				from: result.from,
				into: result.into,
				headSha: result.headSha
			}
		});
		return json({ merge: result });
	} catch (cause) {
		if (cause instanceof WorktreeIntegrationError) {
			audit({
				event_type: 'worktree_merge',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: workdir,
				// A refusal is the guard doing its job; only a git-level failure is
				// an actual error.
				outcome: cause.code === 'git_failed' ? 'failure' : 'denied',
				detail: { conversationId: conversation.id, direction: body.direction, code: cause.code }
			});
			throw error(cause.code === 'git_failed' ? 500 : 409, {
				message: cause.message,
				code: cause.code,
				...(cause.detail ? { detail: cause.detail } : {})
			});
		}
		throw cause;
	}
};
