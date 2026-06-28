import type { Message } from '$lib/types';

/**
 * Where a `tool.call` / `file.edit` event should be applied.
 *
 * - `found`: append the card to `messages[index]` (a known assistant message).
 * - `refresh`: the target can't be located locally — the client is out of sync
 *   (e.g. cards arriving in the gap after a `refreshMessages()` +
 *   `attachStream({ replay: false })` reconnect, before the new assistant
 *   message has been fetched). Re-sync from the server instead of silently
 *   dropping the event.
 */
export type AssistantTargetResult = { kind: 'found'; index: number } | { kind: 'refresh' };

/**
 * Resolve the assistant message a `tool.call` / `file.edit` event belongs to.
 *
 * Prefers an explicit `messageId` (matching how `message.delta` targets by id);
 * an id that doesn't resolve to a known assistant message means we missed the
 * message.start in a reconnect gap, so we ask the caller to refresh. Without a
 * messageId (older in-memory event logs that predate the field) it falls back to
 * the last message when that is an assistant turn.
 */
export function resolveAssistantTarget(
	messages: Pick<Message, 'id' | 'role'>[],
	messageId: string | undefined
): AssistantTargetResult {
	if (messageId) {
		const index = messages.findIndex((m) => m.id === messageId);
		if (index >= 0 && messages[index].role === 'assistant') {
			return { kind: 'found', index };
		}
		return { kind: 'refresh' };
	}
	const last = messages.length - 1;
	if (last >= 0 && messages[last].role === 'assistant') {
		return { kind: 'found', index: last };
	}
	return { kind: 'refresh' };
}
