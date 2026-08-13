import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { conversationId as convCodec } from '$lib/ids';
import * as messages from '$lib/server/db/repos/messages';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { previewCut } from '$lib/server/present/transcript';
import { TRANSCRIPT_INDEX_PREVIEW_MAX_CHARS } from '$lib/payload-limits';

/**
 * Full-transcript text search (wired to the same trigram FTS5 index
 * `searchConversation` uses), returning jump targets for the chat's in-app
 * search box. Results are lightweight — message id + preview — and the client
 * hydrates the window around the chosen hit before scrolling to it.
 */
export const GET: RequestHandler = ({ params, locals, url }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const q = (url.searchParams.get('q') ?? '').trim();
	const rawLimit = Number(url.searchParams.get('limit')) || 20;
	const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : 20, 1), 100);
	if (!q) return json({ results: [] });
	const msgs = messages.searchConversation(convCodec.parse(conv.id), q, { limit });
	const results = msgs.map((m) => ({
		messageId: m.id,
		role: m.role,
		status: m.status,
		createdAt: m.createdAt,
		preview: previewCut(m.content, TRANSCRIPT_INDEX_PREVIEW_MAX_CHARS)
	}));
	return json({ results });
};
