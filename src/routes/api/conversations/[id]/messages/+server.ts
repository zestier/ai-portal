import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { conversationId as convCodec, messageId as msgCodec } from '$lib/ids';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { projectIndexPage } from '$lib/server/present/transcript';
import { TRANSCRIPT_OLDER_PAGE_SIZE } from '$lib/payload-limits';

/**
 * Index-only page of messages older than `beforeId` (the oldest id the client
 * has loaded) — the "load older" path of the backend-projected transcript.
 * Entries carry previews + record descriptors only, so a page stays tiny no
 * matter how big the conversation is.
 */
export const GET: RequestHandler = ({ params, locals, url }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const rawBefore = msgCodec.tryParse(url.searchParams.get('beforeId') ?? '');
	if (rawBefore === null) {
		throw error(400, 'missing or invalid beforeId');
	}
	const rawLimit = Number(url.searchParams.get('limit')) || TRANSCRIPT_OLDER_PAGE_SIZE;
	const limit = Math.min(
		Math.max(Number.isInteger(rawLimit) ? rawLimit : TRANSCRIPT_OLDER_PAGE_SIZE, 1),
		200
	);
	const page = projectIndexPage(convCodec.parse(conv.id), rawBefore, limit);
	return json({ entries: page.entries, hasMore: page.hasMore });
};
