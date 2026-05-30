import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as memory from '$lib/server/db/repos/memory';

export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	return json({ memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	memory.wipe(conv.id);
	return json({ ok: true, memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};
