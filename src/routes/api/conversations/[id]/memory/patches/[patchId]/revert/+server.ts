import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as memory from '$lib/server/db/repos/memory';

export const POST: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const result = memory.revertPatch(conv.id, params.patchId);
	if (!result.patch) throw error(404, 'Memory patch not found.');
	return json({ ...result, memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};
