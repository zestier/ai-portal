import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { regenerateFromAssistant, InlineEditRejected } from '$lib/server/message-edit';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { requireUserId } from '$lib/server/auth/require';

const REJECT_STATUS: Record<string, number> = {
	conversation_not_found: 404,
	message_not_found: 404,
	not_assistant_message: 400,
	no_user_message: 400,
	conversation_busy: 409
};

/**
 * Regenerate a completed assistant message in place. Discards that reply (and
 * anything after it) and re-runs the turn from the unchanged preceding user
 * message, streaming a fresh response in the same conversation.
 *
 * Returns `{ turnId, userMessageId }` so the client can truncate its rendered
 * thread to the preceding user message and reattach to the new turn's stream,
 * symmetrically with the inline-edit flow.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const userId = requireUserId(locals);

	try {
		const { conversation, userMessage } = regenerateFromAssistant({
			userId,
			conversationId: params.id!,
			messageId: params.messageId!
		});
		const turn = await startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		return json({ ok: true, turnId: turn.id, userMessageId: userMessage.id });
	} catch (e) {
		if (e instanceof InlineEditRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throw e;
	}
};
