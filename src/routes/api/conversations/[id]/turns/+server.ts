import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as turnIdempotency from '$lib/server/db/repos/turn-idempotency';
import {
	TurnAlreadyInProgressError,
	releaseTurnReservation,
	reserveTurn
} from '$lib/server/runtime/turn-runner';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { resolveConversationWorkspace, WorkspaceUnavailableError } from '$lib/server/workdir';
import { log } from '$lib/server/log';
import { tryRenameFromFirstUserMessage } from '$lib/server/conversation-title';

const Body = z.object({
	content: z.string().min(1).max(64_000),
	// Optional client-generated key (alternative to the `Idempotency-Key`
	// header) used to dedupe retried sends. See `resolveIdempotencyKey`.
	requestId: z.string().min(1).max(200).optional()
});

// A turn POST may be retried after a client-side timeout (e.g. slow cold-start
// `pool.acquire`), by which point the original message + turn can already
// exist. A client that supplies a stable key — via the `Idempotency-Key`
// header or a `requestId` in the body — lets the retry recover the original
// ids instead of creating a duplicate user message. The header wins when both
// are present; an over-long header is ignored rather than 400-ing the send.
function resolveIdempotencyKey(request: Request, requestId: string | undefined): string | null {
	const header = request.headers.get('idempotency-key')?.trim();
	if (header && header.length <= 200) return header;
	return requestId ?? null;
}

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

	const { content, requestId } = await parseBody(request, Body);
	const idempotencyKey = resolveIdempotencyKey(request, requestId);

	// If this key already started a turn for this conversation, replay the
	// original result. This runs BEFORE the reservation guard so a retry whose
	// original turn has already started — and may still be running — replays
	// the original ids instead of being rejected with a 409. (A retry that
	// races the original *before* it finishes registering still falls through
	// to the reservation guard and gets a 409, which is safe: no duplicate
	// user message is created.)
	if (idempotencyKey) {
		const prior = turnIdempotency.lookup(conv.id, idempotencyKey);
		if (prior) {
			return json({
				turnId: prior.turnId,
				userMessageId: prior.userMessageId,
				title: prior.title
			});
		}
	}

	try {
		resolveConversationWorkspace(conv);
	} catch (cause) {
		if (cause instanceof WorkspaceUnavailableError) {
			throw error(409, { message: cause.message, code: cause.code });
		}
		throw cause;
	}

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

		// Record the key only after the turn is started, so a retry replays a
		// fully-formed result. Best-effort: an idempotency bookkeeping failure
		// must never fail an otherwise-successful send.
		if (idempotencyKey) {
			try {
				turnIdempotency.record({
					conversationId: conv.id,
					key: idempotencyKey,
					messageId: userMsg.id,
					turnId: turn.id,
					title
				});
			} catch (recordErr) {
				// The turn already started successfully, so never fail the send
				// over idempotency bookkeeping — but log it: a dropped write
				// re-opens the duplicate-turn window for a later same-key retry,
				// so the rare failure should be diagnosable rather than silent.
				log.warn('turn.idempotency.record_failed', {
					conversationId: conv.id,
					err: String(recordErr)
				});
			}
		}

		return json({ turnId: turn.id, userMessageId: userMsg.id, title });
	} finally {
		// Once `startTurnFromUserMessage` resolves the real turn is registered
		// (status 'running'), so subsequent POSTs are blocked by the running
		// turn itself; the reservation has done its job. Releasing on the error
		// path keeps a failed start from wedging the conversation.
		releaseTurnReservation(conv.id);
	}
};
