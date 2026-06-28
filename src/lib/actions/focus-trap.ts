import type { Action } from 'svelte/action';

const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusable(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => el.offsetParent !== null || el === document.activeElement
	);
}

export type FocusTrapOptions = {
	/**
	 * Where to place focus when the trap mounts.
	 * - `first` (default): the first focusable control inside the node, falling
	 *   back to the node itself. Good for input-led dialogs.
	 * - `container`: the node itself (which must be focusable, e.g. tabindex="-1").
	 *   Preferred for alertdialogs so a security decision doesn't pre-focus a
	 *   button and the dialog's own key shortcuts (Enter/Escape) fire immediately.
	 */
	initialFocus?: 'first' | 'container';
};

// Focus management for a modal dialog: move focus into the dialog on
// appearance, trap Tab/Shift+Tab within it, and restore focus on destroy.
export const focusTrap: Action<HTMLElement, FocusTrapOptions | undefined> = (node, options) => {
	const previouslyFocused = document.activeElement as HTMLElement | null;

	if (options?.initialFocus === 'container') {
		node.focus();
	} else {
		const focusable = getFocusable(node);
		(focusable[0] ?? node).focus();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;

		const items = getFocusable(node);
		if (items.length === 0) {
			event.preventDefault();
			node.focus();
			return;
		}

		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;

		if (event.shiftKey) {
			if (active === first || active === node || !node.contains(active)) {
				event.preventDefault();
				last.focus();
			}
		} else if (active === last || active === node || !node.contains(active)) {
			event.preventDefault();
			first.focus();
		}
	}

	node.addEventListener('keydown', handleKeydown);

	return {
		destroy() {
			node.removeEventListener('keydown', handleKeydown);
			previouslyFocused?.focus?.();
		}
	};
};
