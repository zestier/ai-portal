import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { inlineEditMessage, InlineEditRejected } from '$lib/server/message-edit';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { throwRerunFailure } from '$lib/server/rerun-error';

const Body = z.object({ content: z.string().trim().min(1).max(64_000) });

const REJECT_STATUS: Record<string, number> = {
	conversation_not_found: 404,
	message_not_found: 404,
	not_user_message: 400,
	content_required: 400,
	conversation_busy: 409
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	authorizeConversation(params.id, locals.userId);
	const userId = requireUserId(locals);
	const { content } = await parseBody(request, Body);

	try {
		const { conversation, userMessage } = inlineEditMessage({
			userId,
			conversationId: params.id!,
			messageId: params.messageId!,
			newContent: content
		});
		const turn = await startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		return json({ ok: true, turnId: turn.id, userMessageId: userMessage.id });
	} catch (e) {
		if (e instanceof InlineEditRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throwRerunFailure({ route: 'message_inline_edit', conversationId: params.id, userId }, e);
	}
};
