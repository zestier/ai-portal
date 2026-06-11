<script lang="ts">
	import type { ToolCallRecord, ReasoningBlockRecord, FileEditRecord } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import {
		getSubagentDisplayState,
		getSubagentPresentation,
		parseSubagentArgs
	} from '$lib/client/subagent-display';
	import ToolCall from './ToolCall.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import DiffView from './DiffView.svelte';
	import Pill from './ui/Pill.svelte';
	import Alert from './ui/Alert.svelte';

	let {
		toolCall,
		childTools = [],
		childReasoning = [],
		childEdits = [],
		conversationId,
		canRetry = false,
		onRetryStarted
	}: {
		toolCall: ToolCallRecord;
		childTools?: ToolCallRecord[];
		childReasoning?: ReasoningBlockRecord[];
		childEdits?: FileEditRecord[];
		conversationId?: string;
		// True only for the latest assistant turn's extractor card while the
		// conversation is idle; older turns' cards and a busy conversation
		// disable the affordance (enforced server-side too).
		canRetry?: boolean;
		onRetryStarted?: (turnId: string) => void;
	} = $props();

	// Auto-expand while the subagent is running so the user sees activity,
	// then auto-collapse once it completes (the parent assistant typically
	// summarizes the result inline anyway). The user can override either
	// direction by clicking; once they do, we stop auto-managing. Some agent
	// types (e.g. the background memory extractor) opt out of auto-expand via
	// their presentation entry and stay collapsed until the user opens them.
	let userToggled = $state(false);
	let manualOpen = $state(false);
	const displayState = $derived(getSubagentDisplayState(toolCall));
	const pending = $derived(displayState.pending);

	const args = $derived(parseSubagentArgs(toolCall.argsJson));

	// Presentation (icon, auto-expand behavior) is data-driven off `agent_type`
	// in subagent-display.ts, so adding or specializing an agent is a registry
	// entry rather than another conditional here. The memory extractor reuses
	// this card but is a distinct background actor, so it gets its own icon and
	// stays collapsed by default.
	const presentation = $derived(getSubagentPresentation(args.agent_type));

	const open = $derived(userToggled ? manualOpen : pending && presentation.autoExpandWhilePending);

	function onToggle(e: Event) {
		const el = e.currentTarget as HTMLDetailsElement;
		userToggled = true;
		manualOpen = el.open;
	}

	const resultText = $derived(displayState.resultText);
	const promptHtml = $derived(args.prompt ? renderMarkdown(args.prompt) : null);
	const resultHtml = $derived(resultText ? renderMarkdown(resultText) : null);

	// The memory extractor reuses this card. For the latest turn's extractor
	// card we surface a "Retry extraction" control that re-runs extraction-only
	// (revert prior patch + re-extract) without re-prompting the model.
	const isMemoryExtractor = $derived(args.agent_type === 'memory-extractor');
	const showRetry = $derived(isMemoryExtractor && canRetry && !!conversationId && !pending);
	let retrying = $state(false);
	let retryError = $state<string | null>(null);

	async function retryExtraction(e: Event) {
		// The button lives in the <summary>; stop the click from toggling the
		// disclosure open/closed.
		e.preventDefault();
		e.stopPropagation();
		if (!conversationId || retrying || !showRetry) return;
		retryError = null;
		retrying = true;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/memory`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			if (!r.ok) {
				const body = await r.text();
				// SvelteKit `error(status, message)` responses are JSON
				// (`{ message }`); fall back to the raw body / status otherwise.
				let message = body;
				try {
					const parsed = JSON.parse(body) as { message?: string };
					if (parsed?.message) message = parsed.message;
				} catch {
					// Non-JSON body: use it verbatim.
				}
				retryError = message || `Retry failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { turnId: string };
			onRetryStarted?.(data.turnId);
		} catch (err) {
			retryError = err instanceof Error ? err.message : String(err);
		} finally {
			retrying = false;
		}
	}

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

	// Child reasoning blocks come in two kinds: 'reasoning' (thinking) and
	// 'content' (the sub-agent's spoken response). Split them so each renders
	// appropriately while still interleaving by timestamp in the timeline.
	const childThinking = $derived(childReasoning.filter((r) => r.kind !== 'content'));
	const childSpoken = $derived(childReasoning.filter((r) => r.kind === 'content'));

	// The sub-agent's spoken response is rendered inline in the activity
	// timeline as 'content' blocks. When it streamed that way, the final tool
	// result is the same text — so suppress the separate "Response" section to
	// avoid showing it twice. Background launches (no streamed content) and
	// agents whose only output is the final result still show it.
	const showResultSection = $derived(resultHtml && childSpoken.length === 0);

	// Sub-agent activity timeline: child content, reasoning bursts, tool calls,
	// and edits in the order they happened, sorted purely by start timestamp.
	type ActivityItem =
		| { kind: 'reasoning'; ts: number; block: ReasoningBlockRecord }
		| { kind: 'content'; ts: number; block: ReasoningBlockRecord }
		| { kind: 'tool'; ts: number; tool: ToolCallRecord }
		| { kind: 'edit'; ts: number; edit: FileEditRecord };

	const activity = $derived.by<ActivityItem[]>(() => {
		const items: ActivityItem[] = [];
		for (const r of childThinking) {
			items.push({ kind: 'reasoning', ts: r.startedAt, block: r });
		}
		for (const r of childSpoken) {
			items.push({ kind: 'content', ts: r.startedAt, block: r });
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
		for (const r of childThinking) {
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

	// Live-ticking elapsed timer. While the agent is running we tick a local
	// clock off the agent's real start timestamp (copied from
	// ReasoningBlock's approach) so the label counts up smoothly instead of
	// sitting at ~0s. On completion we fall back to the settled duration.
	const running = $derived(displayState.running);
	const elapsedStartMs = $derived(displayState.elapsedStartMs);

	let now = $state(Date.now());
	$effect(() => {
		if (!running) return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(id);
	});

	// Under reduced motion we suppress the in-progress timer entirely (no
	// ticking, no frozen number); the final duration still shows on completion.
	let reducedMotion = $state(false);
	$effect(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		const handler = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	const elapsedMs = $derived.by(() => {
		if (running && elapsedStartMs != null) {
			if (reducedMotion) return null;
			return Math.max(0, now - elapsedStartMs);
		}
		return displayState.elapsedMs;
	});
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
		<span class="icon" aria-hidden="true">{presentation.icon}</span>
		<span class="title">{headline}</span>
		{#if args.agent_type}
			<Pill tone="accent">{args.agent_type}</Pill>
		{/if}
		{#if args.model}
			<Pill>{args.model}</Pill>
		{/if}
		{#if args.mode === 'background'}
			<Pill>background</Pill>
		{/if}
		<span class="status status-{displayState.statusClass}">
			{#if pending}<span class="dot" aria-hidden="true"></span>{/if}
			{displayState.statusLabel}
		</span>
		{#if elapsedLabel}
			<span class="elapsed">· {elapsedLabel}</span>
		{/if}
		{#if showRetry}
			<button
				type="button"
				class="retry-btn"
				onclick={retryExtraction}
				disabled={retrying}
				title="Re-run memory extraction for this turn; the prior patch is replaced only if the new extraction succeeds (does not re-prompt the model)"
			>
				{retrying ? 'Retrying…' : 'Retry extraction'}
			</button>
		{/if}
	</summary>
	<div class="content">
		{#if retryError}
			<Alert kind="error">{retryError}</Alert>
		{/if}
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
						{:else if item.kind === 'content'}
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<div class="markdown agent-content">{@html renderMarkdown(item.block.text)}</div>
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
		{#if showResultSection}
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
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
		font-size: var(--fs-md);
	}
	.subagent[data-status='error'] {
		border-left-color: var(--danger);
	}
	.subagent[data-status='denied'] {
		border-left-color: var(--warning);
	}
	.subagent.is-pending {
		animation: subagent-pulse 1.6s ease-in-out infinite;
	}
	@keyframes subagent-pulse {
		0%,
		100% {
			border-left-color: var(--accent);
		}
		50% {
			border-left-color: color-mix(in srgb, var(--accent) 35%, transparent);
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
		font-size: var(--fs-lg);
	}
	.title {
		font-weight: 600;
	}
	.status {
		font-size: var(--eyebrow-fs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--eyebrow-ls);
		color: var(--text-muted);
	}
	.status-ok {
		color: var(--success);
	}
	.status-background {
		color: var(--accent);
	}
	.status-error {
		color: var(--danger);
	}
	.status-denied {
		color: var(--warning);
	}
	.elapsed {
		font-size: var(--fs-xs);
		color: var(--text-muted);
		font-family: var(--mono);
	}
	.retry-btn {
		margin-left: auto;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-muted);
		background: var(--surface-1, transparent);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.1rem 0.5rem;
		cursor: pointer;
		transition:
			color 0.12s ease,
			border-color 0.12s ease;
	}
	.retry-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--accent);
	}
	.retry-btn:disabled {
		opacity: 0.6;
		cursor: default;
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
	.agent-content {
		font-size: var(--text-sm, 0.875rem);
		padding: 0.1rem 0;
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
