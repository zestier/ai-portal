<script lang="ts">
	import { slide } from 'svelte/transition';

	let {
		text,
		streaming = false,
		durationMs = null
	}: {
		text: string;
		streaming?: boolean;
		durationMs?: number | null;
	} = $props();

	// Auto-expand while reasoning is actively streaming, then auto-collapse
	// when the visible message starts arriving. The user can override either
	// direction by clicking; once they do, we stop auto-managing the state.
	let userToggled = $state(false);
	let manualOpen = $state(false);
	const open = $derived(userToggled ? manualOpen : streaming);

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
			<pre>{text}</pre>
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
</style>
