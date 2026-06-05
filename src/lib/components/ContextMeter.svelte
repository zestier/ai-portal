<script lang="ts">
	import type { ConversationUsage } from '$lib/types';

	let {
		usage,
		recentCompaction
	}: {
		usage: ConversationUsage | null;
		recentCompaction?: { tokensRemoved?: number; messagesRemoved?: number } | null;
	} = $props();

	let expanded = $state(false);

	const pct = $derived.by(() => {
		if (!usage || usage.tokenLimit <= 0) return 0;
		return Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
	});

	const level = $derived.by<'low' | 'mid' | 'high'>(() => {
		if (pct >= 90) return 'high';
		if (pct >= 70) return 'mid';
		return 'low';
	});

	const hasBreakdown = $derived(
		usage !== null &&
			(usage.systemTokens !== null ||
				usage.conversationTokens !== null ||
				usage.toolDefinitionsTokens !== null)
	);

	function fmt(n: number | null | undefined): string {
		if (n === null || n === undefined) return '—';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
</script>

{#if usage}
	<div class="meter" data-level={level}>
		<button
			class="bar"
			type="button"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
			aria-label="Context window usage details"
			title={`${usage.currentTokens.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens`}
		>
			<span class="fill" style="width: {pct}%"></span>
			<span class="label">
				ctx {fmt(usage.currentTokens)}/{fmt(usage.tokenLimit)} · {pct.toFixed(0)}%
			</span>
		</button>
		{#if recentCompaction}
			<span class="compaction" role="status">
				✨ compacted{recentCompaction.tokensRemoved
					? ` · −${fmt(recentCompaction.tokensRemoved)} tokens`
					: ''}
			</span>
		{/if}
		{#if expanded && hasBreakdown}
			<dl class="breakdown">
				<dt>system</dt>
				<dd>{fmt(usage.systemTokens)}</dd>
				<dt>conversation</dt>
				<dd>{fmt(usage.conversationTokens)}</dd>
				<dt>tools</dt>
				<dd>{fmt(usage.toolDefinitionsTokens)}</dd>
				<dt>messages</dt>
				<dd>{usage.messagesLength}</dd>
			</dl>
		{/if}
	</div>
{/if}

<style>
	.meter {
		display: inline-flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--fs-xs);
		min-width: 180px;
	}
	.bar {
		position: relative;
		display: block;
		width: 100%;
		height: 18px;
		border-radius: 9px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		overflow: hidden;
		cursor: pointer;
		padding: 0;
		color: inherit;
		text-align: left;
	}
	.bar:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--success);
		opacity: 0.55;
		transition: width 240ms ease-out;
	}
	.meter[data-level='mid'] .fill {
		background: var(--warning);
	}
	.meter[data-level='high'] .fill {
		background: var(--danger);
	}
	.label {
		position: relative;
		display: block;
		padding: 0 0.5rem;
		line-height: 18px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.compaction {
		font-size: var(--fs-md);
		opacity: 0.85;
	}
	.breakdown {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.1rem 0.6rem;
		margin: 0.2rem 0 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
	}
	.breakdown dt {
		opacity: 0.7;
	}
	.breakdown dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
</style>
