<script lang="ts">
	import type { ToolCallRecord } from '$lib/types';
	import DiffView from './DiffView.svelte';
	import TerminalBlock from './tool/TerminalBlock.svelte';
	import ResultBlock from './tool/ResultBlock.svelte';
	import GitToolResult from './tool/GitToolResult.svelte';
	import Alert from './ui/Alert.svelte';
	import { synthesizeDiffs } from '$lib/client/diff-synth';
	import { parseGitToolResult } from '$lib/client/git-tool-result';
	import { summarizeToolCall, splitSummaryForWrap } from '$lib/client/tool-summary';
	import { decodeToolResult, shouldRenderToolResultAsMarkdown } from '$lib/client/tool-result';
	import type { ResultBlock as ResultBlockData } from '$lib/client/tool-result';

	let {
		toolCall,
		conversationId,
		onRerunStarted
	}: {
		toolCall: ToolCallRecord;
		conversationId?: string | undefined;
		onRerunStarted?: ((turnId: string) => void) | undefined;
	} = $props();
	let rerunning = $state(false);
	let rerunError = $state<string | null>(null);

	// Default-closed; users opt in to seeing args + result by clicking.
	// We don't auto-expand while pending: the summary header already
	// surfaces the tool name, target, and progress message, which is
	// enough running feedback for the quick tool calls that make up the
	// bulk of a turn. (Subagents have their own auto-expand because they
	// run longer and have richer interior content.)
	// `task_complete` is the exception because its result is often the
	// assistant's final user-facing summary.
	let userToggled = $state(false);
	let manualOpen = $state(false);
	const defaultOpen = $derived(toolCall.tool === 'task_complete');
	const open = $derived(userToggled ? manualOpen : defaultOpen);

	function onToggle(e: Event) {
		const el = e.currentTarget as HTMLDetailsElement;
		userToggled = true;
		manualOpen = el.open;
	}

	function statusEmoji(s: ToolCallRecord['status']) {
		switch (s) {
			case 'ok':
				return '✓';
			case 'error':
				return '✗';
			case 'denied':
				return '✗';
			default:
				return '⏳';
		}
	}

	const summary = $derived(summarizeToolCall(toolCall.tool, toolCall.argsJson));
	const decoded = $derived(decodeToolResult(toolCall.resultJson));
	const markdownResult = $derived(shouldRenderToolResultAsMarkdown(toolCall.tool));
	const pending = $derived(toolCall.status === 'pending');
	// Image attachments captured for this call (e.g. a `view`ed PNG). Rendered
	// from the authed byte endpoint rather than inlined, so the card stays light
	// and the bytes are only fetched when actually shown.
	const attachmentImages = $derived.by<Extract<ResultBlockData, { kind: 'image' }>[]>(() => {
		if (!conversationId || !toolCall.attachments) return [];
		return toolCall.attachments
			.filter((a) => a.kind === 'image')
			.map((a) => ({
				kind: 'image' as const,
				mimeType: a.mimeType,
				src: `/api/conversations/${conversationId}/tool-calls/${toolCall.id}/attachments/${a.id}`
			}));
	});
	// Edits/creates render as a unified diff synthesized from args. We only
	// show the diff once the call succeeded; while pending we'd be
	// rendering args that haven't been applied, and on error the result
	// text usually explains the failure.
	const renderedDiffs = $derived(toolCall.status === 'ok' ? synthesizeDiffs(toolCall) : []);
	const gitRenderedResult = $derived(
		toolCall.status === 'ok'
			? parseGitToolResult(toolCall.tool, toolCall.argsJson, toolCall.resultJson)
			: null
	);
	const gitDiffText = $derived(
		toolCall.status === 'ok' && toolCall.tool === 'git_diff' && gitRenderedResult === null
			? decoded.fallbackText
			: null
	);
	const rerunDisabledReason = $derived.by(() => {
		if (toolCall.status !== 'denied' && toolCall.status !== 'error') return null;
		if (!conversationId) return 'Conversation context is unavailable.';
		if (toolCall.parentToolCallId) return 'Nested sub-agent tool calls cannot be rerun yet.';
		return null;
	});
	const canRerun = $derived(
		(toolCall.status === 'denied' || toolCall.status === 'error') && rerunDisabledReason === null
	);
	// For shell-style tools, surface the actual command so a viewer
	// doesn't have to expand "Arguments" to see what ran. We thread it
	// into the terminal pane (both live partial output and final result)
	// as a leading `$ command` prompt line.
	const shellCommand = $derived.by(() => {
		const t = toolCall.tool.toLowerCase();
		if (t !== 'bash' && t !== 'shell' && t !== 'run') return null;
		try {
			const a = JSON.parse(toolCall.argsJson);
			if (a && typeof a === 'object' && !Array.isArray(a)) {
				const cmd = (a as Record<string, unknown>).command ?? (a as Record<string, unknown>).cmd;
				return typeof cmd === 'string' && cmd.length > 0 ? cmd : null;
			}
		} catch {
			/* ignore */
		}
		return null;
	});

	function requiresSideEffectConfirmation() {
		return toolCall.tool !== 'view' && toolCall.tool !== 'git_show_file';
	}

	async function rerunWithApproval() {
		if (!conversationId || rerunning || !canRerun) return;
		rerunError = null;
		const sideEffect = requiresSideEffectConfirmation();
		const ok = window.confirm(
			[
				'Rerun this exact failed tool call with a short-lived approval?',
				'',
				`Tool: ${toolCall.tool}`,
				sideEffect
					? 'Risk: this tool may have side effects if repeated.'
					: 'Risk: read-only rerun.',
				'',
				'Arguments:',
				toolCall.argsJson
			].join('\n')
		);
		if (!ok) return;
		rerunning = true;
		try {
			const r = await fetch(
				`/api/conversations/${conversationId}/tool-calls/${toolCall.id}/rerun`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ confirmed: sideEffect })
				}
			);
			if (!r.ok) {
				const body = await r.text();
				rerunError = body || `Rerun failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { turnId: string };
			onRerunStarted?.(data.turnId);
		} catch (e) {
			rerunError = e instanceof Error ? e.message : String(e);
		} finally {
			rerunning = false;
		}
	}
</script>

<details class="tool" class:open class:is-pending={pending} {open} ontoggle={onToggle}>
	<summary>
		<span class="emoji">{statusEmoji(toolCall.status)}</span>
		<code>{toolCall.tool}</code>
		{#if summary}
			<span class="summary-text"
				>{#each splitSummaryForWrap(summary) as chunk, i (i)}{#if i > 0}<wbr
						/>{/if}{chunk}{/each}</span
			>
		{:else}
			<span class="muted">— {toolCall.status}</span>
		{/if}
		{#if pending && toolCall.progressMessage}
			<span class="progress" title={toolCall.progressMessage}>· {toolCall.progressMessage}</span>
		{/if}
	</summary>
	<div class="content">
		<details class="args">
			<summary class="disclosure eyebrow">Arguments</summary>
			<pre><code>{toolCall.argsJson}</code></pre>
		</details>

		{#if toolCall.status === 'denied' || toolCall.status === 'error'}
			<div class="rerun">
				<button
					type="button"
					class="rerun-btn"
					onclick={rerunWithApproval}
					disabled={!canRerun || rerunning}
					title={rerunDisabledReason ?? 'Review exact args, grant short-lived approval, and rerun'}
				>
					{rerunning ? 'Rerunning…' : 'Rerun with approval'}
				</button>
				{#if rerunDisabledReason}
					<span class="muted small">{rerunDisabledReason}</span>
				{/if}
				{#if rerunError}
					<Alert kind="error">{rerunError}</Alert>
				{/if}
			</div>
		{/if}

		{#if !pending && attachmentImages.length > 0}
			{#each attachmentImages as block (block.src)}
				<ResultBlock {block} />
			{/each}
		{/if}

		{#if pending}
			{#if shellCommand || toolCall.partialOutput}
				<TerminalBlock
					text={toolCall.partialOutput ?? ''}
					command={shellCommand ?? undefined}
					streaming
				/>
				{#if toolCall.progressMessage && !toolCall.partialOutput}
					<div class="muted progress-line">{toolCall.progressMessage}</div>
				{/if}
			{:else if toolCall.progressMessage}
				<div class="muted progress-line">{toolCall.progressMessage}</div>
			{:else}
				<div class="muted">Running…</div>
			{/if}
		{:else if toolCall.resultJson}
			{#if gitRenderedResult}
				<GitToolResult result={gitRenderedResult} />
			{:else if gitDiffText}
				<DiffView diff={gitDiffText} collapsible />
			{:else if renderedDiffs.length > 0}
				{#each renderedDiffs as synthDiff, i (synthDiff.path + ':' + i)}
					<DiffView
						path={synthDiff.path}
						diff={synthDiff.diff}
						showLineNumbers={false}
						collapsible
					/>
				{/each}
			{:else}
				{#each decoded.blocks as block, i (i)}
					<ResultBlock
						{block}
						command={i === 0 && shellCommand ? shellCommand : undefined}
						markdown={markdownResult}
					/>
				{/each}
				{#if decoded.followUpHint}
					<div class="muted">{decoded.followUpHint}</div>
				{/if}
			{/if}
			<details class="raw">
				<summary class="disclosure eyebrow">Raw output</summary>
				<pre><code>{toolCall.resultJson}</code></pre>
			</details>
		{/if}
	</div>
</details>

<style>
	.tool {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
		font-size: var(--fs-md);
	}
	.tool.is-pending {
		border-left: 3px solid var(--accent);
		animation: tool-pulse 1.6s ease-in-out infinite;
	}
	@keyframes tool-pulse {
		0%,
		100% {
			border-left-color: var(--accent);
		}
		50% {
			border-left-color: color-mix(in srgb, var(--accent) 35%, transparent);
		}
	}
	summary {
		cursor: pointer;
		list-style: none;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.emoji {
		margin-right: 0.4rem;
	}
	.summary-text {
		margin-left: 0.5rem;
		color: var(--text-muted);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		/* Long, unbroken tokens (deep file paths, URLs) must wrap inside the
		   summary rather than pushing the chat column wide. The injected
		   <wbr>s prefer '/' boundaries; this is the fallback for segments
		   that have no separator yet are still too long for the row. */
		overflow-wrap: anywhere;
	}
	.progress {
		margin-left: 0.5rem;
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-style: italic;
		max-width: 24em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: inline-block;
		vertical-align: bottom;
	}
	.progress-line {
		font-style: italic;
		font-size: var(--fs-sm);
		margin: 0.4rem 0;
	}
	.content {
		margin-top: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.rerun {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.rerun-btn {
		font: inherit;
		font-size: var(--fs-sm);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		padding: 0.25rem 0.5rem;
		cursor: pointer;
	}
	.rerun-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.disclosure {
		cursor: pointer;
		list-style: none;
		color: var(--text-muted);
		user-select: none;
	}
	.disclosure::-webkit-details-marker {
		display: none;
	}
	.args[open] > .disclosure,
	.raw[open] > .disclosure {
		margin-bottom: 0.3rem;
	}
	pre {
		margin: 0;
		max-width: 100%;
		overflow-x: auto;
	}
</style>
