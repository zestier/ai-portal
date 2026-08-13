import { writable } from 'svelte/store';

/**
 * Live, client-side overrides for the sidebar's "active" indicator, keyed by
 * conversation id. Mirrors `awaiting-input.ts`, but the signal arrives from the
 * app-wide event feed (`activity.changed` over `GET /api/events`) rather than
 * from the open conversation's turn stream — so it covers *background*
 * conversations, which is the whole point of the indicator.
 *
 * The server `load` sets (`runningConversationIds` / `unreadConversationIds`)
 * remain the source of truth for the initial render and for anything that
 * happened while the feed was disconnected; an override simply takes precedence
 * for the conversations that have one.
 */
export interface ConversationActivity {
	running: boolean;
	unread: boolean;
}

export const conversationActivityOverrides = writable<Record<string, ConversationActivity>>({});

/** Record a conversation's live activity state (from an `activity.changed` event). */
export function setConversationActivity(
	conversationId: string,
	activity: ConversationActivity
): void {
	conversationActivityOverrides.update((current) => {
		const prev = current[conversationId];
		if (prev && prev.running === activity.running && prev.unread === activity.unread) {
			return current;
		}
		return { ...current, [conversationId]: activity };
	});
}

/**
 * Optimistically clear the unseen flag for a conversation without touching its
 * running state. Used the moment the user opens a chat, so the indicator goes
 * away immediately instead of after the `/read` round-trip.
 */
export function clearConversationUnread(conversationId: string): void {
	conversationActivityOverrides.update((current) => {
		const prev = current[conversationId];
		if (prev && !prev.unread) return current;
		return { ...current, [conversationId]: { running: prev?.running ?? false, unread: false } };
	});
}

/**
 * Drop every live override so the next layout `load` is authoritative again.
 *
 * Called after the app-event feed reconnects: the bus replays what was missed
 * when the gap is short, but beyond its replay buffer / TTL an override could
 * otherwise pin a conversation to a stale state indefinitely — and an override
 * always beats the server set. Clearing on reconnect makes the two converge.
 */
export function clearConversationActivityOverrides(): void {
	conversationActivityOverrides.set({});
}

/**
 * Resolve the effective activity for a conversation: a live override wins when
 * present, otherwise fall back to the server `load` sets.
 */
export function resolveConversationActivity(
	conversationId: string,
	serverRunning: Set<string>,
	serverUnread: Set<string>,
	overrides: Record<string, ConversationActivity>
): ConversationActivity {
	const override = overrides[conversationId];
	if (override) return override;
	return {
		running: serverRunning.has(conversationId),
		unread: serverUnread.has(conversationId)
	};
}

/**
 * Tell the server the user has seen this conversation, and clear the local
 * indicator immediately. Best-effort: a failed POST just means the indicator
 * reappears on the next layout `load`, which is strictly better than surfacing
 * an error for a passive read receipt.
 */
export async function markConversationRead(conversationId: string): Promise<void> {
	clearConversationUnread(conversationId);
	try {
		await fetch(`/api/conversations/${conversationId}/read`, { method: 'POST' });
	} catch {
		/* non-fatal */
	}
}
