import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as turnInputs from '$lib/server/db/repos/turn-inputs';
import { authorizeConversation } from '$lib/server/conversation-auth';

/**
 * Read-only inspector for the *full input* the portal handed to the provider
 * for the turn triggered by this user message: the auto-injected portal
 * prelude, any memory / prior-message context, and the raw user content,
 * exactly as the SDK saw it. Lazily fetched by the message "Input" affordance.
 *
 * Lives on the message resource itself (rather than a nested `/input` route)
 * and returns `{ input: TurnInput | null }` so callers can distinguish
 * "no capture for this message" (older turns, non-user messages) from an error.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	if (!params.messageId) throw error(400, 'missing message id');
	const messageId = Number(params.messageId);
	if (!Number.isInteger(messageId) || messageId <= 0) throw error(400, 'missing message id');
	const input = turnInputs.get(conv.id, messageId);
	return json({ input });
};
