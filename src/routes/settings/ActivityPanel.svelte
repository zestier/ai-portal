<script lang="ts">
	import { decisionLabel, formatTime, type PermissionDecision } from './settings-types';

	let { decisions }: { decisions: PermissionDecision[] } = $props();
</script>

<div
	id="settings-panel-activity"
	class="tab-panel decisions"
	role="tabpanel"
	aria-labelledby="settings-tab-activity"
>
	<div class="section-heading">
		<h2>Recent permission decisions</h2>
		<p class="muted small">
			Audit what was allowed, hard-denied, prompt-denied, or auto-decided recently.
		</p>
	</div>
	{#if decisions.length === 0}
		<p class="muted small">No permission requests have been answered yet.</p>
	{:else}
		<p class="muted small">
			The last {decisions.length} tool permission decisions across your conversations. "Allow always"
			rows also installed a grant for that tool in the listed conversation.
		</p>
		<ul class="decision-list">
			{#each decisions as d (d.id)}
				<li class="decision-row">
					<span class="decision-tag eyebrow {d.decision}">{decisionLabel(d.decision)}</span>
					<code class="tool">{d.tool}</code>
					{#if d.argsSummary}<span class="args" title={d.argsSummary}>{d.argsSummary}</span>{/if}
					<span class="meta">
						in
						<a href="/conversations/{d.conversationId}">{d.conversationTitle ?? d.conversationId}</a
						>
						· {formatTime(d.decidedAt)}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.tab-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.section-heading {
		margin-bottom: 1rem;
	}
	.section-heading h2 {
		margin: 0 0 0.25rem;
		font-size: var(--fs-2xl);
	}
	.section-heading p {
		margin: 0;
	}
	.small {
		font-size: var(--fs-md);
	}
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
	.decision-list {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.decision-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font-size: var(--fs-md);
	}
	.decision-tag {
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}
	.decision-tag.allow-once,
	.decision-tag.allow-always {
		color: var(--success);
		border-color: var(--success);
	}
	.decision-tag.allow-always {
		background: var(--success-bg, transparent);
	}
	.decision-tag.deny,
	.decision-tag.deny-always {
		color: var(--danger);
		border-color: var(--danger);
	}
	.decision-tag.auto-allow {
		color: var(--text-muted);
		border-color: var(--border);
		font-style: italic;
	}
	.decision-tag.auto-deny {
		color: var(--text-muted);
		border-color: var(--border);
		font-style: italic;
	}
	.decision-tag.auto-prompt-required {
		color: var(--warning, var(--text-muted));
		border-color: var(--border);
		font-style: italic;
	}
	.decision-row .tool {
		font-weight: 600;
	}
	.decision-row .args {
		font-family: var(--font-mono, monospace);
		font-size: var(--fs-md);
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.85;
	}
	.decision-row .meta {
		margin-left: auto;
		font-size: var(--fs-sm);
		opacity: 0.75;
	}
</style>
