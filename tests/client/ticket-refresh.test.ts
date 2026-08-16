import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailingDebounce } from '../../src/lib/client/ticket-refresh';

describe('createTrailingDebounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs the action once on the trailing edge after the quiet window', () => {
		const action = vi.fn();
		const debounced = createTrailingDebounce(action, 250);

		debounced.trigger();
		expect(action).not.toHaveBeenCalled();

		vi.advanceTimersByTime(249);
		expect(action).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('coalesces a burst of triggers into a single run', () => {
		const action = vi.fn();
		const debounced = createTrailingDebounce(action, 250);

		for (let i = 0; i < 5; i += 1) {
			debounced.trigger();
			vi.advanceTimersByTime(100); // each within the window, resetting it
		}
		expect(action).not.toHaveBeenCalled();

		vi.advanceTimersByTime(250);
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('runs again for a trigger after the window elapses', () => {
		const action = vi.fn();
		const debounced = createTrailingDebounce(action, 250);

		debounced.trigger();
		vi.advanceTimersByTime(250);
		expect(action).toHaveBeenCalledTimes(1);

		debounced.trigger();
		vi.advanceTimersByTime(250);
		expect(action).toHaveBeenCalledTimes(2);
	});

	it('cancel() prevents a pending run', () => {
		const action = vi.fn();
		const debounced = createTrailingDebounce(action, 250);

		debounced.trigger();
		debounced.cancel();
		vi.advanceTimersByTime(1000);
		expect(action).not.toHaveBeenCalled();
	});
});
