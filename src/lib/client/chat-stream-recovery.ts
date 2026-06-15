export const CHAT_STREAM_STALL_TIMEOUT_MS = 60_000;

// `EventSource.CLOSED` as a bare numeric constant so this module stays pure
// (importable in a non-DOM test environment where the `EventSource` global
// is undefined). Matches the WHATWG ready-state enum.
export const EVENT_SOURCE_CLOSED = 2;

// Whether an EventSource handle should be trusted as a live connection.
// A `null` handle is obviously dead; a non-null one is only live if it is
// not in the CLOSED state. After a tab freeze (screen lock, backgrounded
// tab) the browser can leave a socket CLOSED without ever firing `onerror`,
// so callers must not treat "non-null" as "healthy".
export function streamIsLive(source: { readyState: number } | null): boolean {
	return source !== null && source.readyState !== EVENT_SOURCE_CLOSED;
}

// Whether a foreground/network resume (visibilitychange/focus/online) should
// trigger a re-sync. We only act when the page is actually visible and a turn
// is in flight: a hidden page is still frozen (re-syncing now is pointless and
// races the unfreeze), and with no active turn there is nothing to recover.
export function shouldResumeStream({
	documentHidden,
	activeTurnId
}: {
	documentHidden: boolean;
	activeTurnId: string | null;
}): boolean {
	if (documentHidden) return false;
	return activeTurnId !== null;
}

export type StreamRefreshAction = 'finish' | 'reattach' | 'stay-attached';

export function streamRefreshAction({
	currentTurnId,
	refreshedActiveTurnId,
	hasEventSource
}: {
	currentTurnId: string | null;
	refreshedActiveTurnId: string | null;
	hasEventSource: boolean;
}): StreamRefreshAction {
	if (!refreshedActiveTurnId) {
		return currentTurnId || hasEventSource ? 'finish' : 'stay-attached';
	}
	if (!hasEventSource || refreshedActiveTurnId !== currentTurnId) {
		return 'reattach';
	}
	return 'stay-attached';
}
