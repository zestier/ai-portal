import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sseResponse } from '$lib/server/sse';
import { getTurnById } from '$lib/server/runtime/turn-runner';
import { authorizeConversation } from '$lib/server/conversation-auth';

/**
 * Stream events for an in-flight (or recently-finished, within the
 * grace window) turn. Designed to be consumed by the browser's native
 * `EventSource`:
 *
 *   - GET only, cookie-authed (EventSource cannot send custom headers).
 *   - Emits each event with a monotonic `id:` line so reconnects send
 *     `Last-Event-ID` and we can replay from exactly that offset.
 *   - 410 Gone if the turn id is unknown — the client treats that as
 *     "turn finished + grace expired, refetch persisted messages".
 *
 * 410 (Gone) is preferred over 404 because the grace expiry is a hard
 * permanent end-of-stream — `EventSource` won't auto-retry it.
 */
export const GET: RequestHandler = ({ params, locals, request, url }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const turn = getTurnById(conv.id, params.turnId);
	if (!turn) throw error(410, 'Turn no longer available');

	// Browser auto-reconnect sets this header to the last `id:` it saw.
	const lastIdHeader = request.headers.get('last-event-id');
	let sinceId: number | undefined;
	if (lastIdHeader !== null) {
		const n = Number(lastIdHeader);
		if (Number.isFinite(n) && n >= 0) sinceId = Math.floor(n);
	}

	return sseResponse(
		turn.subscribe({
			signal: request.signal,
			skipReplay: url.searchParams.get('replay') === '0',
			...(sinceId !== undefined ? { sinceId } : {})
		}),
		{
			// Negative ids are sentinels for ephemeral events that aren't part
			// of the replay buffer — omit the `id:` line entirely so the
			// browser's Last-Event-ID stays pointed at the latest persisted id.
			extractId: (item) => (item.id < 0 ? undefined : item.id),
			extractData: (item) => item.event
		}
	);
};
