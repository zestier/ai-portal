import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import { resolveConversationWorkspace } from '$lib/server/workdir';
import { cachedWorktreeIntegrationStatus } from '$lib/server/worktree-integration';

/**
 * Unmerged-work summary for every managed worktree the caller owns, so the
 * sidebar can badge sessions holding work the source checkout doesn't have.
 *
 * Deliberately NOT folded into the layout load: each entry costs a few git
 * subprocesses, and blocking every navigation on them would trade a real
 * latency regression for a decoration. The client fetches this after mount and
 * the service caches briefly, so polling is cheap.
 *
 * A worktree whose checkout has gone missing yields `available: false` rather
 * than failing the whole response — one broken session must not blank the
 * indicator for the rest.
 *
 * `?fresh=1` skips the TTL cache, for a client refreshing because it just saw
 * something (a turn ending, a merge) that changes the answer.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const userId = locals.userId;
	// A client refreshing in response to an event (a turn ended, a merge landed)
	// is asking precisely because the answer just changed, so it opts out of the
	// TTL — otherwise the refresh can return the stale value it was sent to fix.
	const maxAgeMs = url.searchParams.get('fresh') === '1' ? 0 : undefined;
	const managed = convs
		.list(userId, { includeArchived: true })
		.filter((c) => c.workspaceKind === 'managed-worktree');

	const worktrees = await Promise.all(
		managed.map(async (conversation) => {
			try {
				const status = await cachedWorktreeIntegrationStatus(
					resolveConversationWorkspace(conversation),
					maxAgeMs
				);
				return {
					conversationId: conversation.id,
					available: true,
					branch: status.branch,
					upstreamBranch: status.upstreamBranch,
					ahead: status.ahead,
					behind: status.behind,
					dirtyCount: status.dirtyCount,
					unmerged: status.unmerged
				};
			} catch {
				return { conversationId: conversation.id, available: false, unmerged: false };
			}
		})
	);
	return json({ worktrees });
};
