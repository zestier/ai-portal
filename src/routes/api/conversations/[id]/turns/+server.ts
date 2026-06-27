import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { tryRenameFromFirstUserMessage } from '$lib/server/conversation-title';

const Body = z.object({ content: z.string().min(1).max(64_000) });

/**
 * Start a new turn. Returns the new turn id synchronously. The turn runs
 * on the server independently of this request — the client opens an
 * `EventSource` against `/turns/[turnId]/stream` to receive its events.
 *
 * Splitting "start" from "stream" lets us use native `EventSource` for
 * the streaming half (which is GET-only): the browser then handles
 * reconnect + `Last-Event-ID` replay for free, which is what makes the
 * phone-lock-and-unlock case "just work" without custom reconnect glue.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const { content } = await parseBody(request, Body);

	const existing = getTurn(conv.id);
	if (existing && existing.status === 'running') {
		throw error(409, 'A turn is already in progress for this conversation.');
	}

	// Persist user message immediately.
	const userMsg = messages.append(conv.id, { role: 'user', content });
	// Once a turn is started any pending composer draft (e.g. from a deferred
	// edit-fork) has been consumed, so it must not re-seed on future loads.
	convs.clearDraftPrompt(conv.id);
	convs.touch(conv.id);

	const title = tryRenameFromFirstUserMessage(conv, userMsg);
	const initialEvents = title
		? [{ type: 'conversation.update' as const, conversationId: conv.id, title }]
		: undefined;
	const turn = await startTurnFromUserMessage(conv, userMsg, {
		...(initialEvents !== undefined ? { initialEvents } : {})
	});

	return json({ turnId: turn.id, userMessageId: userMsg.id, title });
};
