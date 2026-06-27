// Trailing debouncer used to coalesce a burst of `tickets.changed` app-events
// into a single sidebar refresh. An agent can emit many ticket mutations in one
// turn (e.g. create-then-block-then-block); without coalescing, each would fire
// its own `invalidateAll()` and re-run every layout loader. The trailing edge is
// what we want here: wait until the burst settles, then refresh once with the
// final state.
//
// Extracted from `+layout.svelte` so the timing behavior is unit-testable with
// fake timers (Svelte components aren't exercised by the Vitest/node suite).

export interface Debouncer {
	/** Schedule the action to run after the quiet window; resets the window. */
	trigger(): void;
	/** Cancel any pending run (e.g. on component teardown). */
	cancel(): void;
}

const DEFAULT_DELAY_MS = 250;

/**
 * Create a trailing-edge debouncer. Each `trigger()` (re)starts a `delayMs`
 * timer; `action` runs once when the timer elapses with no further triggers.
 */
export function createTrailingDebounce(action: () => void, delayMs = DEFAULT_DELAY_MS): Debouncer {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	return {
		trigger() {
			cancel();
			timer = setTimeout(() => {
				timer = undefined;
				action();
			}, delayMs);
		},
		cancel
	};
}
