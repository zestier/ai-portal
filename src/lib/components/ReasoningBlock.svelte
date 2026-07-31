<script lang="ts">
	import { slide } from 'svelte/transition';
	import { formatFieldBytes } from '$lib/client/lazy-field';
	import { ensureLazyField, lazyFieldState, loadLazyField } from '$lib/client/lazy-field.svelte';
	import Alert from './ui/Alert.svelte';

	let {
		text,
		streaming = false,
		durationMs = null,
		lazy = null
	}: {
		/**
		 * The reasoning text, or null when the conversation payload trimmed it for
		 * size. A null text is never rendered as empty thinking — see `lazy`.
		 */
		text: string | null;
		streaming?: boolean;
		durationMs?: number | null;
		/**
		 * How to fetch trimmed text on demand. Supplying this hydrates the block
		 * the first time it is expanded; the collapsed header is unaffected, since
		 * it is drawn entirely from `durationMs`.
		 */
		lazy?: { conversationId: string; reasoningBlockId: string; bytes?: number | undefined } | null;
	} = $props();

	// Lazily-fetched text for a trimmed block. Keyed by record in a shared store,
	// never held on this instance: the transcript's each-blocks are index-keyed,
	// so an instance can be re-bound to a different reasoning block and must not
	// then render the previous block's thinking under the new one's header.
	const lazyState = $derived(
		lazy ? lazyFieldState(lazy.conversationId, 'reasoning-text', lazy.reasoningBlockId) : null
	);
	const resolvedText = $derived(text ?? lazyState?.value ?? null);
	const lazyLoading = $derived(lazyState?.loading === true);
	const lazyError = $derived(lazyState?.error ?? null);

	function loadText() {
		if (!lazy) return;
		void loadLazyField(lazy.conversationId, 'reasoning-text', lazy.reasoningBlockId);
	}

	// Auto-expand while reasoning is actively streaming, then auto-collapse
	// when the visible message starts arriving. The user can override either
	// direction by clicking; once they do, we stop auto-managing the state.
	let userToggled = $state(false);
	let manualOpen = $state(false);
	const open = $derived(userToggled ? manualOpen : streaming);

	// Fetch trimmed text on first expand — never on open, which is the entire
	// point of the trim.
	$effect(() => {
		if (open && lazy && text === null) {
			ensureLazyField(lazy.conversationId, 'reasoning-text', lazy.reasoningBlockId);
		}
	});

	function toggle() {
		userToggled = true;
		manualOpen = !open;
	}

	// Live-tick the elapsed counter while streaming so the header doesn't
	// look frozen between reasoning deltas.
	let now = $state(Date.now());
	let startedAt = $state(Date.now());
	$effect(() => {
		if (!streaming) return;
		startedAt = Date.now() - (durationMs ?? 0);
		const id = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(id);
	});

	const elapsedSec = $derived.by(() => {
		if (durationMs != null && !streaming) return Math.max(0, Math.round(durationMs / 1000));
		return Math.max(0, Math.round((now - startedAt) / 1000));
	});

	const headerLabel = $derived(
		streaming ? `Thinking… ${elapsedSec}s` : `Thought for ${elapsedSec}s`
	);
</script>

<div class="reasoning" class:is-streaming={streaming}>
	<button
		type="button"
		class="header"
		onclick={toggle}
		aria-expanded={open}
		aria-controls="reasoning-body"
	>
		<svg
			class="chevron"
			class:open
			width="10"
			height="10"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M5 4l5 4-5 4" />
		</svg>
		<span class="label">{headerLabel}</span>
		{#if streaming}
			<span class="pulse" aria-hidden="true"></span>
		{/if}
	</button>
	{#if open}
		<div id="reasoning-body" class="body" transition:slide={{ duration: 140 }}>
			{#if resolvedText !== null}
				<pre>{resolvedText}</pre>
			{:else if lazyLoading}
				<p class="lazy muted">Loading reasoning…</p>
			{:else if lazyError}
				<div class="lazy">
					<Alert kind="error">
						{lazyError}
						<button type="button" class="load-text" onclick={loadText}>Retry</button>
					</Alert>
				</div>
			{:else if lazy}
				<p class="lazy">
					<button type="button" class="load-text" onclick={loadText}>
						Load reasoning{lazy.bytes ? ` (${formatFieldBytes(lazy.bytes)})` : ''}
					</button>
				</p>
			{:else}
				<p class="lazy muted">Reasoning is unavailable.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.reasoning {
		border-left: 2px solid var(--border);
		padding-left: 0.6rem;
		margin: 0.15rem 0 0.35rem;
		font-size: var(--fs-md);
		color: var(--text-muted);
	}
	.reasoning.is-streaming {
		border-left-color: color-mix(in srgb, var(--accent) 60%, var(--border));
	}
	.header {
		background: none;
		border: 0;
		padding: 0.1rem 0;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: inherit;
		font: inherit;
		cursor: pointer;
		opacity: 0.85;
	}
	.header:hover {
		opacity: 1;
	}
	.header:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.chevron {
		transition: transform 0.12s ease;
		flex: none;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	.label {
		font-style: italic;
	}
	.pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: reasoning-pulse 1s ease-in-out infinite;
	}
	@keyframes reasoning-pulse {
		0%,
		100% {
			opacity: 0.3;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
		.chevron {
			transition: none;
		}
	}
	.body {
		margin-top: 0.3rem;
		max-height: 280px;
		overflow-y: auto;
	}
	.body pre {
		margin: 0;
		padding: 0.4rem 0.5rem;
		font-size: var(--code-fs);
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-muted);
	}
	.lazy {
		margin: 0;
		padding: 0.4rem 0.5rem;
		font-size: var(--fs-sm);
	}
	.lazy.muted {
		color: var(--text-muted);
	}
	.load-text {
		font: inherit;
		font-size: var(--fs-sm);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}
</style>
