import { describe, expect, it } from 'vitest';
import {
	DEFAULT_STICKY_BOTTOM_THRESHOLD_PX,
	distanceFromBottom,
	isNearBottom,
	planStickyBottomContentUpdate,
	shouldShowJumpToLatest,
	updateStickyBottomFromScroll,
	type StickyBottomState
} from '../src/lib/client/sticky-bottom';

describe('sticky bottom scrolling', () => {
	const pinned: StickyBottomState = { pinnedToBottom: true, hasNewBelow: false };
	const detached: StickyBottomState = { pinnedToBottom: false, hasNewBelow: false };

	it('treats positions within the threshold as pinned to the bottom', () => {
		expect(distanceFromBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 })).toBe(50);
		expect(
			isNearBottom(
				{
					scrollHeight: 1000,
					clientHeight: 400,
					scrollTop: 600 - DEFAULT_STICKY_BOTTOM_THRESHOLD_PX
				},
				DEFAULT_STICKY_BOTTOM_THRESHOLD_PX
			)
		).toBe(true);
		expect(
			isNearBottom(
				{
					scrollHeight: 1000,
					clientHeight: 400,
					scrollTop: 600 - DEFAULT_STICKY_BOTTOM_THRESHOLD_PX - 1
				},
				DEFAULT_STICKY_BOTTOM_THRESHOLD_PX
			)
		).toBe(false);
	});

	it('detaches when the user scrolls away and reattaches near the bottom', () => {
		const away = updateStickyBottomFromScroll(pinned, {
			scrollHeight: 1000,
			clientHeight: 400,
			scrollTop: 200
		});
		expect(away).toEqual({ pinnedToBottom: false, hasNewBelow: false });

		const back = updateStickyBottomFromScroll(
			{ pinnedToBottom: false, hasNewBelow: true },
			{
				scrollHeight: 1000,
				clientHeight: 400,
				scrollTop: 580
			}
		);
		expect(back).toEqual({ pinnedToBottom: true, hasNewBelow: false });
	});

	it('ignores programmatic scroll events so smooth jumps do not look like user scrolls', () => {
		const state = updateStickyBottomFromScroll(
			{ pinnedToBottom: true, hasNewBelow: false },
			{
				scrollHeight: 1000,
				clientHeight: 400,
				scrollTop: 300
			},
			{ programmatic: true }
		);

		expect(state).toEqual({ pinnedToBottom: true, hasNewBelow: false });
	});

	it('only follows new content while pinned unless forced', () => {
		expect(planStickyBottomContentUpdate(pinned)).toEqual({
			shouldScroll: true,
			state: { pinnedToBottom: true, hasNewBelow: false }
		});
		expect(planStickyBottomContentUpdate(detached)).toEqual({
			shouldScroll: false,
			state: { pinnedToBottom: false, hasNewBelow: true }
		});
		expect(planStickyBottomContentUpdate(detached, { force: true })).toEqual({
			shouldScroll: true,
			state: { pinnedToBottom: true, hasNewBelow: false }
		});
	});

	it('shows the jump affordance whenever the user is detached from the bottom', () => {
		expect(shouldShowJumpToLatest(pinned)).toBe(false);
		expect(shouldShowJumpToLatest(detached)).toBe(true);
		expect(shouldShowJumpToLatest({ pinnedToBottom: false, hasNewBelow: true })).toBe(true);
	});
});
