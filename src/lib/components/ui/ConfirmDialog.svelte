<script lang="ts">
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';

	let {
		open = false,
		title,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		busy = false,
		onConfirm,
		onCancel,
		children
	}: {
		/** Whether the confirmation dialog is shown. */
		open?: boolean;
		/** Heading announced as the alertdialog label. */
		title: string;
		/** Label for the affirmative (destructive) action. */
		confirmLabel?: string;
		/** Label for the dismissive action. */
		cancelLabel?: string;
		/** Style the confirm button as destructive. */
		danger?: boolean;
		/** Disable the confirm button while the action is in flight. */
		busy?: boolean;
		onConfirm: () => void;
		onCancel: () => void;
		/** Body content describing the consequences of confirming. */
		children: Snippet;
	} = $props();
</script>

<Modal {open} onClose={onCancel} role="alertdialog" ariaLabel={title} width="min(440px, 100%)">
	<div class="confirm">
		<h2 class="confirm-title">{title}</h2>
		<div class="confirm-body">{@render children()}</div>
		<div class="confirm-actions">
			<button type="button" class="btn sm ghost" onclick={onCancel}>{cancelLabel}</button>
			<button
				type="button"
				class={`btn sm primary${danger ? ' danger' : ''}`}
				disabled={busy}
				onclick={onConfirm}
			>
				{confirmLabel}
			</button>
		</div>
	</div>
</Modal>

<style>
	.confirm {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.confirm-title {
		margin: 0;
		font-size: var(--fs-lg);
	}
	.confirm-body {
		margin: 0;
		color: var(--text-muted);
		line-height: 1.5;
	}
	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
