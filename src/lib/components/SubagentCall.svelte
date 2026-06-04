<script lang="ts">
	import type { ToolCallRecord, ReasoningBlockRecord, FileEditRecord } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import { getSubagentDisplayState, parseSubagentArgs } from '$lib/client/subagent-display';
	import ToolCall from './ToolCall.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import DiffView from './DiffView.svelte';

	let {
		toolCall,
		childTools = [],
		childReasoning = [],
		childEdits = []
	}: {
		toolCall: ToolCallRecord;
		childTools?: ToolCallRecord[];
		childReasoning?: ReasoningBlockRecord[];
		childEdits?: FileEditRecord[];
	} = $props();

	// Auto-expand while the subagent is running so the user sees activity,
	// then auto-collapse once it completes (the parent assistant typically
	// summarizes the result inline anyway). The user can override either
	// direction by clicking; once they do, we stop auto-managing.
	let userToggled = $state(false);
	let manualOpen = $state(false);
	const displayState = $derived(getSubagentDisplayState(toolCall));
	const pending = $derived(displayState.pending);
	const open = $derived(userToggled ? manualOpen : pending);

	function onToggle(e: Event) {
		const el = e.currentTarget as HTMLDetailsElement;
		userToggled = true;
		manualOpen = el.open;
	}

	const args = $derived(parseSubagentArgs(toolCall.argsJson));
	const resultText = $derived(displayState.resultText);
	const promptHtml = $derived(args.prompt ? renderMarkdown(args.prompt) : null);
	const resultHtml = $derived(resultText ? renderMarkdown(resultText) : null);

	function firstLine(s: string, max = 80): string {
		const line =
			s
				.split(/\r?\n/)
				.find((l) => l.trim().length > 0)
				?.trim() ?? '';
		return line.length > max ? line.slice(0, max - 1) + '…' : line;
	}

	const headline = $derived(
		args.description ?? args.name ?? (args.prompt ? firstLine(args.prompt) : 'subagent')
	);

	// Sub-agent activity timeline: child reasoning bursts and tool calls in
	// the order they happened. There's no parent-text to anchor against
	// (the sub-agent's only output is the final response, which we render
	// separately), so we sort purely by start timestamp.
	type ActivityItem =
		| { kind: 'reasoning'; ts: number; block: ReasoningBlockRecord }
		| { kind: 'tool'; ts: number; tool: ToolCallRecord }
		| { kind: 'edit'; ts: number; edit: FileEditRecord };

	const activity = $derived.by<ActivityItem[]>(() => {
		const items: ActivityItem[] = [];
		for (const r of childReasoning) {
			items.push({ kind: 'reasoning', ts: r.startedAt, block: r });
		}
		for (const t of childTools) {
			items.push({ kind: 'tool', ts: t.startedAt, tool: t });
		}
		for (const e of childEdits) {
			items.push({ kind: 'edit', ts: e.createdAt, edit: e });
		}
		items.sort((a, b) => a.ts - b.ts);
		return items;
	});

	// While the sub-agent is still running, the latest open reasoning
	// segment should keep ticking its "Thinking… Xs" header.
	const latestOpenChildReasoningIdx = $derived.by(() => {
		if (!pending) return -1;
		let max = -1;
		for (const r of childReasoning) {
			if (r.durationMs == null && r.segmentIndex > max) max = r.segmentIndex;
		}
		return max;
	});
	// Activity section auto-expands while the subagent runs (so streaming
	// reasoning/tool calls are visible) and auto-collapses on completion,
	// since the final Response usually summarizes everything anyway. Click
	// to override either direction.
	let activityUserToggled = $state(false);
	let activityManualOpen = $state(false);
	const activityOpen = $derived(activityUserToggled ? activityManualOpen : pending);
	function onActivityToggle(e: Event) {
		const el = e.currentTarget as HTMLDetailsElement;
		activityUserToggled = true;
		activityManualOpen = el.open;
	}

	const elapsedMs = $derived(displayState.elapsedMs);
	const elapsedLabel = $derived.by(() => {
		if (elapsedMs == null) return null;
		const s = Math.round(elapsedMs / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rem = s % 60;
		return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
	});
</script>

<details
	class="subagent"
	class:open
	class:is-pending={pending}
	data-status={toolCall.status}
	data-display-status={displayState.statusClass}
	{open}
	ontoggle={onToggle}
>
	<summary>
		<span class="icon" aria-hidden="true">🤖</span>
		<span class="title">{headline}</span>
		{#if args.agent_type}
			<span class="badge type">{args.agent_type}</span>
		{/if}
		{#if args.model}
			<span class="badge model">{args.model}</span>
		{/if}
		{#if args.mode === 'background'}
			<span class="badge mode">background</span>
		{/if}
		<span class="status status-{displayState.statusClass}">
			{#if pending}<span class="dot" aria-hidden="true"></span>{/if}
			{displayState.statusLabel}
		</span>
		{#if elapsedLabel}
			<span class="elapsed">· {elapsedLabel}</span>
		{/if}
	</summary>
	<div class="content">
		{#if promptHtml}
			<details class="section prompt">
				<summary class="disclosure">
					<svg
						class="chevron"
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
						<path d="M5 3l6 5-6 5" />
					</svg>
					<span class="label">Prompt</span>
				</summary>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="markdown">{@html promptHtml}</div>
			</details>
		{/if}
		{#if activity.length > 0}
			<details class="section activity" open={activityOpen} ontoggle={onActivityToggle}>
				<summary class="disclosure">
					<svg
						class="chevron"
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
						<path d="M5 3l6 5-6 5" />
					</svg>
					<span class="label">Activity</span>
					<span class="count">{activity.length}</span>
				</summary>
				<div class="timeline">
					{#each activity as item, i (i)}
						{#if item.kind === 'reasoning'}
							<ReasoningBlock
								text={item.block.text}
								streaming={item.block.segmentIndex === latestOpenChildReasoningIdx}
								durationMs={item.block.durationMs}
							/>
						{:else if item.kind === 'tool'}
							<ToolCall toolCall={item.tool} />
						{:else}
							<DiffView path={item.edit.path} diff={item.edit.diff} />
						{/if}
					{/each}
				</div>
			</details>
		{/if}
		{#if displayState.isBackgroundLaunch}
			<div class="section response background-launch">
				<div class="label static">Response</div>
				<div class="markdown">
					{#if displayState.backgroundAgentId}
						<p>
							{displayState.lifecycleText} Agent ID:
							<code>{displayState.backgroundAgentId}</code>.
						</p>
					{:else}
						<p>{displayState.lifecycleText}</p>
					{/if}
					<p>
						Use <code>read_agent</code>{#if displayState.backgroundAgentId}
							with this ID{/if} to retrieve results, or <code>list_agents</code> to view background agents.
					</p>
				</div>
			</div>
		{/if}
		{#if resultHtml}
			<div class="section response">
				<div class="label static">
					{displayState.isBackgroundLaunch ? 'Launch result' : 'Response'}
				</div>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="markdown">{@html resultHtml}</div>
			</div>
		{:else if toolCall.status === 'pending'}
			<div class="section">
				<div class="label static">Response</div>
				<div class="muted">Waiting for subagent to finish…</div>
			</div>
		{/if}
		{#if !resultHtml && toolCall.resultJson}
			<details class="section raw">
				<summary class="disclosure">
					<svg
						class="chevron"
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
						<path d="M5 3l6 5-6 5" />
					</svg>
					<span class="label">Raw output</span>
				</summary>
				<pre><code>{toolCall.resultJson}</code></pre>
			</details>
		{/if}
	</div>
</details>

<style>
	.subagent {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent, #7c5cff);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
		font-size: var(--fs-md);
	}
	.subagent[data-status='error'] {
		border-left-color: var(--danger, #e5484d);
	}
	.subagent[data-status='denied'] {
		border-left-color: var(--warning, #f5a524);
	}
	.subagent.is-pending {
		animation: subagent-pulse 1.6s ease-in-out infinite;
	}
	@keyframes subagent-pulse {
		0%,
		100% {
			border-left-color: var(--accent, #7c5cff);
		}
		50% {
			border-left-color: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent);
		}
	}
	.dot {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		background: currentColor;
		margin-right: 0.25em;
		vertical-align: middle;
		animation: subagent-dot 1s ease-in-out infinite;
	}
	@keyframes subagent-dot {
		0%,
		100% {
			opacity: 0.35;
		}
		50% {
			opacity: 1;
		}
	}
	summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.icon {
		font-size: 1.05em;
	}
	.title {
		font-weight: 600;
	}
	.badge {
		display: inline-block;
		font-size: var(--fs-xs);
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-sm);
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text-muted);
		font-family: var(--mono);
		text-transform: lowercase;
	}
	.badge.type {
		color: var(--text);
		border-color: var(--accent, #7c5cff);
	}
	.status {
		font-size: var(--eyebrow-fs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--eyebrow-ls);
		color: var(--text-muted);
	}
	.status-ok {
		color: var(--success, #30a46c);
	}
	.status-background {
		color: var(--accent, #7c5cff);
	}
	.status-error {
		color: var(--danger, #e5484d);
	}
	.status-denied {
		color: var(--warning, #f5a524);
	}
	.elapsed {
		font-size: var(--fs-xs);
		color: var(--text-muted);
		font-family: var(--mono);
	}
	.content {
		margin-top: var(--space-2);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.section {
		border-top: 1px solid var(--border);
		padding-top: var(--space-2);
	}
	.section:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.label {
		font-size: var(--eyebrow-fs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--eyebrow-ls);
		color: var(--text-muted);
		margin-bottom: 0.3rem;
	}
	.label.static {
		cursor: default;
	}
	.disclosure {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		cursor: pointer;
		list-style: none;
		margin-bottom: 0.3rem;
		user-select: none;
		color: var(--text-muted);
		border-radius: var(--radius-sm);
		padding: 0.05rem 0.25rem;
		margin-left: -0.25rem;
		transition:
			color 0.12s ease,
			background 0.12s ease;
	}
	.disclosure::-webkit-details-marker {
		display: none;
	}
	.disclosure:hover {
		color: var(--text);
		background: var(--surface-hover, transparent);
	}
	.disclosure .label {
		margin-bottom: 0;
	}
	.chevron {
		transition: transform 0.15s ease;
	}
	details[open] > .disclosure .chevron {
		transform: rotate(90deg);
	}
	.markdown :global(p:first-child) {
		margin-top: 0;
	}
	.markdown :global(p:last-child) {
		margin-bottom: 0;
	}
	.markdown :global(pre) {
		max-width: 100%;
		overflow-x: auto;
	}
	.muted {
		color: var(--text-muted);
		font-style: italic;
	}
	.timeline {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.prompt[open] > .disclosure,
	.activity[open] > .disclosure,
	.raw[open] > .disclosure {
		margin-bottom: 0.4rem;
	}
	.count {
		font-size: var(--fs-xs);
		color: var(--text-muted);
		font-family: var(--mono);
	}
	pre {
		max-width: 100%;
		overflow-x: auto;
	}
</style>
