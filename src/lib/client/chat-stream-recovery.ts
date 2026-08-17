export const CHAT_STREAM_STALL_TIMEOUT_MS = 60_000;

// A longer-fused stall timeout used while a blocking interactive prompt is
// outstanding. The normal stall timer is disarmed during a prompt (we expect
// the user to take their time clicking), but if the server-side handler times
// out, the process restarts, or the stream dies mid-permission WITHOUT emitting
// `interactive.resolved`, the client would otherwise sit on the dialog forever.
// This long fuse eventually re-syncs from the server (`refreshMessages`), which
// snaps the dialog queue + stream state back to the authoritative `pending`
// map — clearing a prompt the server no longer holds, or re-arming for another
// interval if it does.
export const CHAT_INTERACTIVE_STALL_TIMEOUT_MS =
  5 * CHAT_STREAM_STALL_TIMEOUT_MS;

// How long the stall timer should wait before firing recovery, or `null` when
// it should not arm at all (no live stream / no active turn). Pure so the
// branching is unit-testable without timers or a DOM. A pending interactive
// uses the longer fuse rather than disabling recovery entirely.
export function streamStallDelayMs({
  hasEventSource,
  activeTurnId,
  pendingInteractiveCount,
}: {
  hasEventSource: boolean;
  activeTurnId: string | null;
  pendingInteractiveCount: number;
}): number | null {
  if (!hasEventSource || !activeTurnId) return null;
  return pendingInteractiveCount > 0
    ? CHAT_INTERACTIVE_STALL_TIMEOUT_MS
    : CHAT_STREAM_STALL_TIMEOUT_MS;
}

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
  activeTurnId,
}: {
  documentHidden: boolean;
  activeTurnId: string | null;
}): boolean {
  if (documentHidden) return false;
  return activeTurnId !== null;
}

export type StreamRefreshAction = "finish" | "reattach" | "stay-attached";

export function streamRefreshAction({
  currentTurnId,
  refreshedActiveTurnId,
  hasEventSource,
}: {
  currentTurnId: string | null;
  refreshedActiveTurnId: string | null;
  hasEventSource: boolean;
}): StreamRefreshAction {
  if (!refreshedActiveTurnId) {
    return currentTurnId || hasEventSource ? "finish" : "stay-attached";
  }
  if (!hasEventSource || refreshedActiveTurnId !== currentTurnId) {
    return "reattach";
  }
  return "stay-attached";
}
