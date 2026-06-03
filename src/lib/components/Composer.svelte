<script lang="ts">
	import { tick } from 'svelte';

	let {
		value = $bindable(''),
		streaming = false,
		placeholder = 'Message...',
		onSend,
		onStop
	}: {
		value?: string;
		streaming?: boolean;
		placeholder?: string;
		onSend: () => void;
		onStop: () => void;
	} = $props();

	let textareaEl: HTMLTextAreaElement | undefined;

	function autoGrow() {
		const el = textareaEl;
		if (!el) return;
		el.style.height = 'auto';
		const max = 260;
		el.style.height = Math.min(el.scrollHeight, max) + 'px';
	}

	function reportAutoGrowError(error: unknown) {
		queueMicrotask(() => {
			throw error;
		});
	}

	$effect(() => {
		// Re-run autoGrow whenever the composer text changes. `tick()` waits
		// for the DOM (including `bind:this`) to settle so the very first
		// run after mount actually has `textareaEl` to measure — without
		// this guard the textarea could fall back to its native rows=1
		// rendering, which differs across browsers and occasionally paints
		// unusually tall.
		void value;
		void tick().then(autoGrow).catch(reportAutoGrowError);
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			// On touch devices (no fine pointer), let Enter insert a newline
			// and require the send button — otherwise mobile users have no
			// way to add newlines.
			const coarse =
				typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(pointer: coarse)').matches;
			if (coarse) return;
			e.preventDefault();
			// `onSend` is responsible for deciding whether a send is allowed
			// (e.g. it no-ops while streaming or when the draft is empty), so
			// the composer doesn't need to know why a send might be rejected.
			onSend();
		}
	}
</script>

<form
	class="composer"
	onsubmit={(e) => {
		e.preventDefault();
		onSend();
	}}
>
	<div class="composer-shell" class:is-streaming={streaming}>
		<textarea
			bind:this={textareaEl}
			bind:value
			onkeydown={onKeydown}
			oninput={autoGrow}
			{placeholder}
			rows="1"
		></textarea>
		<div class="composer-actions">
			<span class="kbd-hint muted" aria-hidden="true">
				<kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
			</span>
			{#if streaming}
				<button
					class="icon-btn stop"
					type="button"
					onclick={onStop}
					title="Stop generating"
					aria-label="Stop generating"
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<rect x="3" y="3" width="10" height="10" rx="1.5" />
					</svg>
				</button>
			{:else}
				<button
					class="icon-btn send"
					type="submit"
					disabled={!value.trim()}
					title="Send (Enter)"
					aria-label="Send message"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.75"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M2 8L14 2L9.5 14L8 9L2 8Z" />
					</svg>
				</button>
			{/if}
		</div>
	</div>
</form>

<style>
	.composer {
		border-top: 1px solid var(--border);
		padding: var(--space-3) var(--space-5) var(--space-4);
		display: flex;
		flex-direction: column;
	}
	.composer-shell {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: var(--space-2) 0.6rem 0.45rem;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease,
			background 0.15s ease;
	}
	.composer-shell:focus-within {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.composer-shell.is-streaming {
		background: var(--surface-2);
	}
	.composer-shell textarea {
		width: 100%;
		min-height: 28px;
		max-height: 260px;
		border: none;
		background: transparent;
		padding: 0.3rem 0.25rem;
		resize: none;
		outline: none;
		box-shadow: none;
		line-height: 1.5;
		font-size: var(--fs-md);
		/* Browsers that support field-sizing auto-size the textarea to its
		   content without help from JS, eliminating any first-paint flash
		   where the native rows=1 height (which varies between browsers
		   and inherits body line-height before our local rules apply)
		   could render unusually tall. The JS autoGrow above remains the
		   fallback for browsers without support. */
		field-sizing: content;
	}
	.composer-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.kbd-hint {
		margin-right: auto;
		font-size: var(--fs-xs);
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		opacity: 0.75;
		user-select: none;
	}
	.kbd-hint kbd {
		font-family: var(--mono);
		font-size: 0.68rem;
		padding: 0.05rem 0.32rem;
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text-muted);
		line-height: 1.2;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background 0.12s ease,
			color 0.12s ease,
			transform 0.08s ease,
			border-color 0.12s ease;
	}
	.icon-btn:active {
		transform: scale(0.94);
	}
	.icon-btn.send {
		background: var(--accent);
		color: var(--accent-text);
	}
	.icon-btn.send:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.icon-btn.send:disabled {
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: not-allowed;
		opacity: 0.7;
	}
	.icon-btn.stop {
		background: transparent;
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
	}
	.icon-btn.stop:hover {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	@media (max-width: 480px) {
		.kbd-hint {
			display: none;
		}
	}
	@media (pointer: coarse) {
		.kbd-hint {
			display: none;
		}
	}
</style>
