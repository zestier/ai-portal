import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import {
	worktreeIntegrationStatus,
	WorktreeIntegrationError
} from '$lib/server/worktree-integration';

/**
 * How this conversation's workspace sits relative to the source checkout. Read
 * uncached: the UI calls this after actions, where a stale answer would look
 * like the action did nothing.
 *
 * Not restricted to `managed-worktree` conversations — a shared conversation
 * whose workdir happens to be a linked worktree gets the same answer, and one
 * pointed at the main checkout simply reports `isLinkedWorktree: false`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	try {
		return json({ worktree: await worktreeIntegrationStatus(workdir) });
	} catch (cause) {
		if (cause instanceof WorktreeIntegrationError) {
			// A non-repository workdir is a normal state, not a failure: report it
			// as "nothing to integrate" so the client needs no special case.
			return json({ worktree: null, code: cause.code });
		}
		throw cause;
	}
};
