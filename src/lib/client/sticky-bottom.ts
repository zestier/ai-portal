export const DEFAULT_STICKY_BOTTOM_THRESHOLD_PX = 64;

export type ScrollMetrics = {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
};

export type StickyBottomState = {
	pinnedToBottom: boolean;
	hasNewBelow: boolean;
};

export function distanceFromBottom(metrics: ScrollMetrics): number {
	return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function isNearBottom(
	metrics: ScrollMetrics,
	thresholdPx = DEFAULT_STICKY_BOTTOM_THRESHOLD_PX
): boolean {
	return distanceFromBottom(metrics) <= thresholdPx;
}

export function updateStickyBottomFromScroll(
	state: StickyBottomState,
	metrics: ScrollMetrics,
	opts: { programmatic?: boolean; thresholdPx?: number } = {}
): StickyBottomState {
	if (opts.programmatic) return state;

	const pinnedToBottom = isNearBottom(metrics, opts.thresholdPx);
	return {
		pinnedToBottom,
		hasNewBelow: pinnedToBottom ? false : state.hasNewBelow
	};
}

export function planStickyBottomContentUpdate(
	state: StickyBottomState,
	opts: { force?: boolean } = {}
): { shouldScroll: boolean; state: StickyBottomState } {
	if (opts.force || state.pinnedToBottom) {
		return {
			shouldScroll: true,
			state: { pinnedToBottom: true, hasNewBelow: false }
		};
	}

	return {
		shouldScroll: false,
		state: { pinnedToBottom: false, hasNewBelow: true }
	};
}

export function shouldShowJumpToLatest(state: StickyBottomState): boolean {
	return !state.pinnedToBottom;
}
