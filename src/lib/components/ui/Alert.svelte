<script lang="ts">
	import type { Snippet } from 'svelte';
	type Kind = 'info' | 'success' | 'warning' | 'error';
	let {
		kind = 'info',
		dismissible = false,
		ondismiss,
		children
	}: {
		kind?: Kind;
		dismissible?: boolean;
		ondismiss?: () => void;
		children: Snippet;
	} = $props();
</script>

<div
	class="alert"
	data-kind={kind}
	role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'}
>
	<span class="body">{@render children()}</span>
	{#if dismissible}
		<button class="btn icon ghost sm dismiss" aria-label="Dismiss" onclick={() => ondismiss?.()}
			>×</button
		>
	{/if}
</div>

<style>
	.alert {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--surface);
		font-size: var(--fs-md);
	}
	.alert[data-kind='info'] {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
		background: var(--accent-bg);
	}
	.alert[data-kind='success'] {
		border-color: color-mix(in srgb, var(--success) 40%, var(--border));
		background: var(--success-bg);
	}
	.alert[data-kind='warning'] {
		border-color: color-mix(in srgb, var(--warning) 50%, var(--border));
		background: var(--warning-bg);
	}
	.alert[data-kind='error'] {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		background: var(--danger-bg);
		color: var(--danger);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.dismiss {
		margin: -0.15rem -0.25rem -0.15rem 0;
		font-size: var(--fs-xl);
		line-height: 1;
	}
</style>
