<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title,
		meta,
		actions,
		fullBleed = false
	}: {
		title?: string | Snippet;
		meta?: Snippet;
		actions?: Snippet;
		fullBleed?: boolean;
	} = $props();
</script>

<header class="panel-header" class:full-bleed={fullBleed}>
	<div class="row">
		<div class="title">
			{#if typeof title === 'string'}
				<h2>{title}</h2>
			{:else if title}
				{@render title()}
			{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</div>
	{#if meta}<div class="meta muted">{@render meta()}</div>{/if}
</header>

<style>
	.panel-header {
		padding: var(--space-3) var(--space-5);
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	/* Pulls the header to the edges of a panel that has 1rem padding and
	   overflow: hidden, so the bottom border spans full width. */
	.panel-header.full-bleed {
		margin: -1rem -1rem 1rem;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.title {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.title :global(h2) {
		margin: 0;
		font-size: var(--fs-lg);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.meta {
		font-size: var(--fs-xs);
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
