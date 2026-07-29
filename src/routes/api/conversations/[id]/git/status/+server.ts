import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkspace, leaseIdFromUrl } from '$lib/server/conversation-auth';
import { headInfo } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkspace(params.id, locals.userId, leaseIdFromUrl(url));
	const status = await headInfo(workdir);
	return json({ status });
};
