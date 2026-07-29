import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { publishConversationActivity } from '$lib/server/runtime/conversation-activity';

// POST /api/conversations/:id/read — mark the conversation seen up to now.
//
// Clears the "unseen response" half of the sidebar's active indicator. Called
// by the open chat when it mounts and again whenever a turn finishes while the
// user is looking at it (the page `load` alone can't cover output that streams
// in after the load). Idempotent, and monotonic in the repo, so redundant calls
// and out-of-order delivery are both harmless.
export const POST: RequestHandler = ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const lastReadAt = Date.now();
	convs.markRead(conv.id, conv.userId, lastReadAt);
	publishConversationActivity(conv.userId, conv.id, getTurn(conv.id)?.status === 'running');
	return json({ ok: true, lastReadAt });
};
