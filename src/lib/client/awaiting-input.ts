import { writable } from 'svelte/store';

/**
 * Live, client-side overrides for the sidebar "awaiting input" indicator,
 * keyed by conversation id.
 *
 * Only the currently-open conversation writes here (from `Chat.svelte`'s turn
 * stream), giving the sidebar a live signal — a prompt appearing or being
 * resolved/cancelled — without a server round-trip or a layout reload. The
 * server `load` set (`awaitingConversationIds`) remains the source of truth for
 * every other (background) conversation and for the initial page load; the
 * override simply takes precedence for the one conversation that owns it.
 *
 * Single source of live truth: `Chat.svelte` derives the value straight from
 * its own `pendingInteractive` (filtered to blocking kinds), so the sidebar and
 * the chat can never disagree about the open conversation.
 */
export const awaitingInputOverrides = writable<Record<number, boolean>>({});

/** Record (or update) the open conversation's live awaiting-input state. */
export function setAwaitingInput(conversationId: number, awaiting: boolean): void {
	awaitingInputOverrides.update((current) => {
		if (current[conversationId] === awaiting) return current;
		return { ...current, [conversationId]: awaiting };
	});
}

/**
 * Drop a conversation's live override (e.g. when its chat unmounts) so the
 * sidebar falls back to the server `load` value for it.
 */
export function clearAwaitingInput(conversationId: number): void {
	awaitingInputOverrides.update((current) => {
		if (!(conversationId in current)) return current;
		const next = { ...current };
		delete next[conversationId];
		return next;
	});
}

/**
 * Resolve the effective awaiting-input state for a conversation: a live
 * override wins when present, otherwise fall back to the server `load` set.
 */
export function isAwaitingInput(
	conversationId: number,
	serverAwaiting: Set<number>,
	overrides: Record<number, boolean>
): boolean {
	if (conversationId in overrides) return overrides[conversationId];
	return serverAwaiting.has(conversationId);
}
