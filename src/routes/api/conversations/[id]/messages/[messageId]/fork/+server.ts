import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { forkAtMessage, ForkRejected } from '$lib/server/fork';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';
import { throwRerunFailure } from '$lib/server/rerun-error';

// `content` present => edit a user message with the new text.
// `content` absent  => retry from an assistant message (uses post snapshot).
const Body = z.object({ content: z.string().min(1).max(64_000).optional() });

const REJECT_STATUS: Record<string, number> = {
	source_not_found: 404,
	message_not_found: 404,
	not_user_message: 400,
	unsupported_role: 400,
	content_required: 400,
	content_not_allowed: 400
};

/**
 * Fork a conversation from a given message.
 *
 *  - Body `{ content }`  → edit that user message, re-run from there.
 *  - Body `{}`           → retry from that assistant message.
 *
 * Returns `{ conversationId }` of the new fork. The client should
 * navigate to it to continue. When the source has a running turn an
 * edit-fork is created without auto-starting its turn; the response carries
 * `{ deferred: true }`. The edited text is persisted as the new
 * conversation's `draft_prompt` and seeded into its composer on load, so the
 * client just navigates and lets the user press Send.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	const sourceId = params.id!;
	const messageId = params.messageId!;
	// Accept an empty body for retry-from-assistant.
	const parsed = await parseBody(request, Body, { allowEmpty: true });

	try {
		const { conversation, userMessage, deferred } = await forkAtMessage({
			userId,
			sourceConversationId: sourceId,
			messageId,
			newContent: parsed.content ?? null
		});
		if (!userMessage) {
			return json({ ok: true, conversationId: conversation.id, deferred });
		}
		const turn = await startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		return json({ ok: true, conversationId: conversation.id, turnId: turn.id });
	} catch (e) {
		if (e instanceof ForkRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throwRerunFailure({ route: 'message_fork', conversationId: sourceId, userId }, e);
	}
};
