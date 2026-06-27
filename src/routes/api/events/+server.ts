import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sseResponse } from '$lib/server/sse';
import { getAppEventBus } from '$lib/server/runtime/app-events';

/**
 * Per-user global event feed. The app shell opens exactly one of these and
 * keeps it for the session, receiving lightweight cross-conversation signals
 * (currently `awaiting.changed`) for *any* of the user's conversations —
 * unlike the per-turn stream, which only covers the one conversation a client
 * has open.
 *
 *   - GET only, cookie-authed (EventSource can't send custom headers).
 *   - Each event carries a monotonic `id:` line so a reconnect sends
 *     `Last-Event-ID` and the bus replays from exactly that offset.
 *   - 401 if unauthenticated.
 *
 * SINGLE-INSTANCE: the backing bus is per-process (same caveat as the
 * interactive registry that feeds it). A multi-instance deployment would need
 * a cross-process bus behind the `AppEventBus` interface.
 */
export const GET: RequestHandler = ({ locals, request }) => {
	const userId = locals.userId;
	if (!userId) throw error(401, 'Not authenticated');

	// Browser auto-reconnect sets this header to the last `id:` (a ULID) it saw.
	// Opaque cursor — passed straight through; the bus orders it lexicographically.
	const lastIdHeader = request.headers.get('last-event-id');
	const sinceId = lastIdHeader && lastIdHeader.length > 0 ? lastIdHeader : undefined;

	return sseResponse(
		getAppEventBus().subscribe(userId, {
			signal: request.signal,
			...(sinceId !== undefined ? { sinceId } : {})
		}),
		{
			extractId: (item) => item.id,
			extractData: (item) => item.event
		}
	);
};
