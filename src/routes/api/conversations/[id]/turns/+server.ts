import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import {
	TurnAlreadyInProgressError,
	releaseTurnReservation,
	reserveTurn
} from '$lib/server/runtime/turn-runner';
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

	// Synchronously claim the turn slot BEFORE persisting the user message.
	// In memory mode `startTurnFromUserMessage` awaits `pool.release(...)`
	// before `startTurn` registers the turn, so a plain `getTurn` guard leaves
	// a window where two concurrent POSTs both pass, both append a user
	// message, and the loser throws (a 500) with its message orphaned. The
	// reservation closes that window with no intervening await, so the second
	// request is rejected here — before it writes anything — as a clean 409.
	try {
		reserveTurn(conv.id);
	} catch (e) {
		if (e instanceof TurnAlreadyInProgressError) {
			throw error(409, 'A turn is already in progress for this conversation.');
		}
		throw e;
	}

	try {
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
	} finally {
		// Once `startTurnFromUserMessage` resolves the real turn is registered
		// (status 'running'), so subsequent POSTs are blocked by the running
		// turn itself; the reservation has done its job. Releasing on the error
		// path keeps a failed start from wedging the conversation.
		releaseTurnReservation(conv.id);
	}
};
