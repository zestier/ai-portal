<script module lang="ts">
	// Shared across all Modal instances so stacked modals lock/unlock body scroll
	// with reference counting instead of clobbering each other's saved value.
	let scrollLockDepth = 0;
	let previousBodyOverflow = '';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = false,
		onClose,
		labelledby,
		describedby,
		ariaLabel,
		role = 'dialog',
		closeOnBackdrop = true,
		width = 'min(680px, 100%)',
		maxHeight = 'min(760px, 90vh)',
		panelClass = '',
		children
	}: {
		/** Whether the modal is shown. Drives the native <dialog> show/close. */
		open?: boolean;
		/** Called for every dismissal request (Escape, backdrop click, close UI). */
		onClose?: () => void;
		labelledby?: string;
		describedby?: string;
		ariaLabel?: string;
		role?: 'dialog' | 'alertdialog';
		/** Allow clicking the dimmed backdrop to dismiss. */
		closeOnBackdrop?: boolean;
		/** CSS width of the panel (any valid CSS length/expression). */
		width?: string;
		/** CSS max-height of the panel. */
		maxHeight?: string;
		/** Extra class(es) for the panel element. */
		panelClass?: string;
		children: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	// Drive the native <dialog> modal state from `open` so the platform gives us
	// a focus trap, an inert background, and Escape handling for free.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open) {
			if (!el.open) el.showModal();
		} else if (el.open) {
			el.close();
		}
	});

	// Lock background scroll while open and restore it on close/unmount. A shared
	// depth counter keeps the lock correct when modals stack: only the first open
	// snapshots the previous value and only the last close restores it.
	$effect(() => {
		if (!open) return;
		if (scrollLockDepth === 0) {
			previousBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
		}
		scrollLockDepth += 1;
		return () => {
			scrollLockDepth -= 1;
			if (scrollLockDepth === 0) {
				document.body.style.overflow = previousBodyOverflow;
			}
		};
	});

	function handleCancel(event: Event) {
		// Native Escape fires `cancel`; route it through onClose so the caller
		// owns the open state instead of letting the dialog self-close.
		event.preventDefault();
		onClose?.();
	}

	// Track where the press started so a drag that begins inside the panel (e.g.
	// selecting text) and releases over the backdrop doesn't count as a dismiss.
	let pressedOnBackdrop = false;

	function handleBackdropPointerDown(event: MouseEvent) {
		pressedOnBackdrop = event.target === dialogEl;
	}

	function handleBackdropClick(event: MouseEvent) {
		// The transparent <dialog> fills the viewport; a click whose press and
		// release both land on the dialog itself (not the panel) hit the backdrop.
		const onBackdrop = pressedOnBackdrop && event.target === dialogEl;
		pressedOnBackdrop = false;
		if (closeOnBackdrop && onBackdrop) onClose?.();
	}
</script>

<dialog
	bind:this={dialogEl}
	class="modal"
	{role}
	aria-labelledby={labelledby}
	aria-describedby={describedby}
	aria-label={ariaLabel}
	oncancel={handleCancel}
	onmousedown={handleBackdropPointerDown}
	onclick={handleBackdropClick}
>
	{#if open}
		<div
			class={`modal-panel ${panelClass}`.trim()}
			style={`--modal-width: ${width}; --modal-max-height: ${maxHeight};`}
		>
			{@render children()}
		</div>
	{/if}
</dialog>

<style>
	/* The <dialog> itself is a transparent, full-viewport centring container; the
	   dim comes from ::backdrop and the visible card is .modal-panel. Keeping the
	   dialog full-bleed lets us detect backdrop clicks via event.target. */
	.modal {
		position: fixed;
		inset: 0;
		width: 100%;
		max-width: 100%;
		height: 100%;
		max-height: 100%;
		margin: 0;
		padding: var(--space-4);
		border: 0;
		background: transparent;
		overflow: auto;
		display: grid;
		place-items: center;
		z-index: var(--z-modal);
	}
	.modal:not([open]) {
		display: none;
	}
	.modal::backdrop {
		background: var(--overlay);
	}
	.modal-panel {
		width: var(--modal-width, min(680px, 100%));
		max-height: var(--modal-max-height, min(760px, 90vh));
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		padding: var(--space-4);
	}
</style>
