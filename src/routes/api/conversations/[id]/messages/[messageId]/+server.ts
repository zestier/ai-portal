import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { conversationId as convCodec, messageId as msgCodec } from '$lib/ids';
import * as turnInputs from '$lib/server/db/repos/turn-inputs';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { projectMessageForOwner } from '$lib/server/present/transcript';

/**
 * GET returns the full body of one message (content + records, oversized
 * fields trimmed to markers) for on-demand hydration of the backend-projected
 * transcript — the client fetches it when an index entry scrolls near the
 * viewport or the user expands a collapsed message. Ownership is enforced by
 * scoping the repo read to the conversation: a message id that doesn't exist
 * here is a flat 404.
 *
 * The same route also serves `{ input }` — the full provider input captured
 * for the turn triggered by this (user) message, read by the "Input"
 * inspector — so both lazy reads share one endpoint.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const convId = convCodec.parse(conv.id);
	if (!params.messageId) throw error(400, 'missing message id');
	const messageId = msgCodec.tryParse(params.messageId);
	if (messageId === null) throw error(400, 'missing message id');
	const message = projectMessageForOwner(convId, messageId);
	if (!message) throw error(404);
	const input = turnInputs.get(convId, messageId);
	return json({ message, input });
};
