<script lang="ts">
	import type { Message, ToolCallRecord, FileEditRecord, ReasoningBlockRecord } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import { copyableCodeBlocks } from '$lib/client/copyable-code-blocks';
	import ToolCall from './ToolCall.svelte';
	import SubagentCall from './SubagentCall.svelte';
	import DiffView from './DiffView.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import ThinkingIndicator from './ThinkingIndicator.svelte';
	import Pill from '$lib/components/ui/Pill.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import RawInputDialog from './RawInputDialog.svelte';
	import { goto } from '$app/navigation';

	let {
		message,
		conversationId,
		inputMessageId = null,
		forks = [],
		isInFlightTurnUser = false,
		thinking = false,
		canRetryMemory = false,
		busy = false,
		onForked,
		onInlineEdited,
		onRegenerated,
		onToolRerunStarted,
		onMemoryRetryStarted
	}: {
		message: Message;
		conversationId?: string;
		inputMessageId?: string | null;
		forks?: Array<{ id: string; title: string; archivedAt: number | null }>;
		isInFlightTurnUser?: boolean;
		thinking?: boolean;
		// True when this is the latest assistant message and the conversation is
		// idle, enabling the memory extractor card's "Retry extraction" control.
		canRetryMemory?: boolean;
		// True when the conversation has an in-flight (streaming) turn. Used to
		// disable the in-place regenerate action, which would be rejected server
		// side with `conversation_busy`. Forking is still allowed while busy.
		busy?: boolean;
		onForked?: () => void;
		onInlineEdited?: (messageId: string, content: string, turnId: string) => void;
		onRegenerated?: (userMessageId: string, turnId: string) => void;
		onToolRerunStarted?: (turnId: string) => void;
		onMemoryRetryStarted?: (turnId: string) => void;
	} = $props();

	let editing = $state(false);
	let editText = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let showRawInput = $state(false);

	// The full provider input is captured per turn and keyed to the user
	// message that triggered it, but it reads more naturally on the assistant
	// turn it produced. The parent passes `inputMessageId` (the triggering
	// user message) for assistant messages whose input was captured; optimistic
	// (`local-` / `err-`) user messages never have a stored input and are
	// excluded upstream.
	const canInspectInput = $derived(
		message.role === 'assistant' && !!conversationId && !!inputMessageId
	);

	// Editing is only possible for persisted user messages (a temporary
	// id like `local-1234` is created optimistically before the server
	// confirms; we can't fork from those). It also requires the parent to
	// pass the conversation id. Forking is allowed while the source is busy,
	// but NOT on the user message that triggered the in-flight turn — that
	// is the live, streaming turn's boundary and editing it makes no sense.
	const canEdit = $derived(
		message.role === 'user' &&
			!!conversationId &&
			!isInFlightTurnUser &&
			!message.id.startsWith('local-') &&
			!message.id.startsWith('err-')
	);

	// Assistant-message actions: regenerate the reply in place, or fork the
	// thread up to here into a new conversation. Both require a persisted,
	// completed assistant message and the parent's conversation id.
	const canAssistantActions = $derived(
		message.role === 'assistant' &&
			message.status === 'complete' &&
			!!conversationId &&
			!message.id.startsWith('local-')
	);

	const liveForks = $derived(forks.filter((f) => f.archivedAt == null));

	function beginEdit() {
		editText = message.content;
		errorMsg = null;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		errorMsg = null;
	}

	async function submitForkEdit() {
		const text = editText.trim();
		if (!text || !conversationId || submitting) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/fork`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
			if (!r.ok) {
				const body = await r.text();
				errorMsg = body || `Fork failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as {
				conversationId: string;
				turnId?: string;
				deferred?: boolean;
			};
			onForked?.();
			// When the source was busy the fork's turn isn't auto-started; the
			// server persisted the edited text as the new conversation's draft,
			// which its page load seeds into the composer. So we just navigate —
			// no client-side prefill relay (which was lost on reload).
			await goto(`/conversations/${data.conversationId}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	async function submitInlineEdit() {
		const text = editText.trim();
		if (!text || !conversationId || submitting) return;
		const confirmed = window.confirm(
			'Edit this message in the current conversation? This will discard all later messages in this thread and re-run from the edited prompt.'
		);
		if (!confirmed) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/edit`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
			if (!r.ok) {
				const body = await r.text();
				errorMsg = body || `Inline edit failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { turnId: string; userMessageId: string };
			editing = false;
			onInlineEdited?.(data.userMessageId, text, data.turnId);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	async function regenerate() {
		if (!conversationId || submitting || busy) return;
		const confirmed = window.confirm(
			'Regenerate this response? This will discard this reply and any later messages in this thread and re-run from your previous prompt.'
		);
		if (!confirmed) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(
				`/api/conversations/${conversationId}/messages/${message.id}/regenerate`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}'
				}
			);
			if (!r.ok) {
				const body = await r.text();
				errorMsg = body || `Regenerate failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { turnId: string; userMessageId: string };
			onRegenerated?.(data.userMessageId, data.turnId);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	async function continueInNewConversation() {
		if (!conversationId || submitting) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/fork`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			if (!r.ok) {
				const body = await r.text();
				errorMsg = body || `Continue failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { conversationId: string };
			onForked?.();
			await goto(`/conversations/${data.conversationId}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	const reasoningStreaming = $derived(
		message.role === 'assistant' && message.status === 'streaming'
	);

	type Part =
		| { kind: 'text'; html: string }
		| { kind: 'tool'; tool: ToolCallRecord }
		| { kind: 'edit'; edit: FileEditRecord }
		| { kind: 'reasoning'; block: ReasoningBlockRecord; streaming: boolean };

	const parts = $derived.by<Part[]>(() => {
		if (message.role !== 'assistant') return [];
		const content = message.content ?? '';
		// Filter out children of sub-agent task calls — they belong inside
		// the outer SubagentCall card, not at the message level.
		const tools = (message.toolCalls ?? []).filter((t) => t.parentToolCallId == null);
		const edits = (message.fileEdits ?? []).filter((e) => e.parentToolCallId == null);
		const reasoning = (message.reasoningBlocks ?? []).filter((r) => r.parentToolCallId == null);

		// Only the latest still-open block on a streaming message ticks the
		// "Thinking… Xs" header. A reasoning block is "open" until its
		// durationMs is set (by message.reasoning.end at the bridge boundary).
		// Anything earlier shows its final "Thought for Xs".
		let latestOpenSegmentIdx = -1;
		if (reasoningStreaming) {
			for (const r of reasoning) {
				if (r.durationMs == null && r.segmentIndex > latestOpenSegmentIdx) {
					latestOpenSegmentIdx = r.segmentIndex;
				}
			}
		}

		// Anything without an explicit offset is rendered after all text
		// (legacy rows persisted before interleaving was tracked).
		const trailingTools: ToolCallRecord[] = [];
		const trailingEdits: FileEditRecord[] = [];
		const trailingReasoning: ReasoningBlockRecord[] = [];

		type Anchor =
			| { offset: number; ts: number; kind: 'tool'; tool: ToolCallRecord }
			| { offset: number; ts: number; kind: 'edit'; edit: FileEditRecord }
			| {
					offset: number;
					ts: number;
					kind: 'reasoning';
					block: ReasoningBlockRecord;
			  };
		const anchors: Anchor[] = [];
		// Sort tiebreaker at the same textOffset is the wall-clock timestamp
		// captured at stream time (reasoning.startedAt, tool.startedAt,
		// edit.createdAt). Reasoning bursts and the tool they precede share
		// an offset (no visible text between them); using a real temporal
		// tiebreaker keeps the rendered order matching the actual stream
		// order — reason → tool → reason → tool — instead of bunching all
		// reasoning above all tools.
		for (const r of reasoning) {
			if (r.textOffset == null) trailingReasoning.push(r);
			else
				anchors.push({
					offset: Math.min(r.textOffset, content.length),
					ts: r.startedAt,
					kind: 'reasoning',
					block: r
				});
		}
		for (const t of tools) {
			if (t.textOffset == null) trailingTools.push(t);
			else
				anchors.push({
					offset: Math.min(t.textOffset, content.length),
					ts: t.startedAt,
					kind: 'tool',
					tool: t
				});
		}
		for (const e of edits) {
			if (e.textOffset == null) trailingEdits.push(e);
			else
				anchors.push({
					offset: Math.min(e.textOffset, content.length),
					ts: e.createdAt,
					kind: 'edit',
					edit: e
				});
		}
		anchors.sort((a, b) => a.offset - b.offset || a.ts - b.ts);

		const out: Part[] = [];
		let cursor = 0;
		for (const a of anchors) {
			if (a.offset > cursor) {
				out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor, a.offset)) });
				cursor = a.offset;
			}
			if (a.kind === 'tool') out.push({ kind: 'tool', tool: a.tool });
			else if (a.kind === 'edit') out.push({ kind: 'edit', edit: a.edit });
			else
				out.push({
					kind: 'reasoning',
					block: a.block,
					streaming: a.block.segmentIndex === latestOpenSegmentIdx
				});
		}
		if (cursor < content.length) {
			out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor)) });
		}
		for (const r of trailingReasoning) {
			out.push({
				kind: 'reasoning',
				block: r,
				streaming: r.segmentIndex === latestOpenSegmentIdx
			});
		}
		for (const t of trailingTools) out.push({ kind: 'tool', tool: t });
		for (const e of trailingEdits) out.push({ kind: 'edit', edit: e });

		// Coalesce visually-adjacent reasoning segments (no tool/edit/text
		// between them) into a single thinking box. The underlying segments
		// are still persisted distinctly; this is purely a render-time
		// merge so users don't see two "Thought for Xs" boxes back-to-back
		// just because the model emitted a tool that was then cancelled or
		// because the SDK chunked a single thought into two bursts.
		const merged: Part[] = [];
		for (const p of out) {
			const prev = merged[merged.length - 1];
			if (p.kind === 'reasoning' && prev && prev.kind === 'reasoning') {
				// Concatenate text with a blank line separator so the two
				// bursts remain visually distinct inside the same block.
				const text = `${prev.block.text}\n\n${p.block.text}`;
				// Sum finite durations; null wins (still open) so the header
				// keeps ticking via the streaming flag.
				const durationMs =
					prev.block.durationMs == null || p.block.durationMs == null
						? null
						: prev.block.durationMs + p.block.durationMs;
				merged[merged.length - 1] = {
					kind: 'reasoning',
					streaming: prev.streaming || p.streaming,
					block: {
						...prev.block,
						text,
						durationMs
					}
				};
			} else {
				merged.push(p);
			}
		}
		return merged;
	});
</script>

<article class="msg" data-role={message.role}>
	<header class="eyebrow">
		<span class="role">{message.role}</span>
		{#if message.status !== 'complete' && message.status !== 'streaming'}
			<span class="status muted">({message.status})</span>
		{/if}
		{#if liveForks.length > 0}
			<span class="fork-badges" aria-label="Forks from this message">
				{#each liveForks as f (f.id)}
					<a class="fork-badge" href={`/conversations/${f.id}`} title={`Open fork: ${f.title}`}>
						<Pill>
							<svg
								width="10"
								height="10"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<circle cx="5" cy="4" r="1.6" />
								<circle cx="5" cy="12" r="1.6" />
								<circle cx="11" cy="8" r="1.6" />
								<path d="M5 5.6v4.8" />
								<path d="M5 8h4.6" />
							</svg>
							<span class="fork-title">{f.title}</span>
						</Pill>
					</a>
				{/each}
			</span>
		{/if}
		{#if canInspectInput}
			<button
				type="button"
				class="action-btn input-btn"
				onclick={() => (showRawInput = true)}
				title="Inspect the full input sent to the provider for this turn (portal prelude, memory/context, and your message)"
				aria-label="View raw turn input"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M2.5 4.5h11" />
					<path d="M2.5 8h11" />
					<path d="M2.5 11.5h7" />
				</svg>
				Input
			</button>
		{/if}
		{#if canEdit && !editing}
			<button
				type="button"
				class="action-btn edit-btn"
				onclick={beginEdit}
				title="Edit this message inline or fork it into a new conversation"
				aria-label="Edit message"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
				</svg>
				Edit
			</button>
		{/if}
		{#if canAssistantActions}
			<button
				type="button"
				class="action-btn retry-btn"
				onclick={regenerate}
				disabled={submitting || busy}
				title={busy
					? 'Regenerate is unavailable while a response is in progress'
					: 'Regenerate this response (discards it and re-runs from your previous prompt)'}
				aria-label="Regenerate this response"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M3 8a5 5 0 018.5-3.5L13 6" />
					<path d="M13 3v3h-3" />
					<path d="M13 8a5 5 0 01-8.5 3.5L3 10" />
					<path d="M3 13v-3h3" />
				</svg>
				Retry
			</button>
			<button
				type="button"
				class="action-btn fork-btn"
				onclick={continueInNewConversation}
				disabled={submitting}
				title="Clone this conversation up to here into a new conversation (shares the workdir)"
				aria-label="Continue from here in a new conversation"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M5 3.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
					<path d="M14 5.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
					<path d="M3.5 5v3a3 3 0 003 3h2" />
					<path d="M11 12.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
				</svg>
				Continue in new conversation
			</button>
		{/if}
	</header>
	<div class="body">
		{#if message.role === 'assistant'}
			{#each parts as p, i (i)}
				{#if p.kind === 'text'}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="text-part" use:copyableCodeBlocks>{@html p.html}</div>
				{:else if p.kind === 'tool'}
					{@const childTools = (message.toolCalls ?? []).filter(
						(t) => t.parentToolCallId === p.tool.id
					)}
					{@const childReasoning = (message.reasoningBlocks ?? []).filter(
						(r) => r.parentToolCallId === p.tool.id
					)}
					{@const childEdits = (message.fileEdits ?? []).filter(
						(e) => e.parentToolCallId === p.tool.id
					)}
					{#if p.tool.tool === 'task'}
						<SubagentCall
							toolCall={p.tool}
							{conversationId}
							canRetry={canRetryMemory}
							onRetryStarted={onMemoryRetryStarted}
							{childTools}
							{childReasoning}
							{childEdits}
						/>
					{:else}
						<ToolCall toolCall={p.tool} {conversationId} onRerunStarted={onToolRerunStarted} />
					{/if}
				{:else if p.kind === 'reasoning'}
					<ReasoningBlock
						text={p.block.text}
						streaming={p.streaming}
						durationMs={p.block.durationMs}
					/>
				{:else}
					<DiffView path={p.edit.path} diff={p.edit.diff} />
				{/if}
			{/each}
			{#if thinking}
				<ThinkingIndicator />
			{/if}
		{:else if editing}
			<form
				class="edit-form"
				onsubmit={(e) => {
					e.preventDefault();
					submitForkEdit();
				}}
			>
				<textarea bind:value={editText} rows="3" disabled={submitting} aria-label="Edited message"
				></textarea>
				<div class="edit-actions">
					<span class="hint muted">
						Fork keeps this thread unchanged. Inline edit discards later messages in this thread.
					</span>
					<button type="button" class="btn sm" onclick={cancelEdit} disabled={submitting}
						>Cancel</button
					>
					<button
						type="button"
						class="btn danger sm"
						disabled={submitting || !editText.trim()}
						title="Destructively replace this message, remove later history, and re-run here"
						onclick={submitInlineEdit}
					>
						Edit inline & re-run
					</button>
					<button
						type="submit"
						class="btn primary sm"
						disabled={submitting || !editText.trim()}
						title="Create a fork with the edited prompt, leave this thread unchanged, and re-run there"
					>
						{submitting ? 'Saving…' : 'Fork & re-run'}
					</button>
				</div>
				{#if errorMsg}
					<Alert kind="error">{errorMsg}</Alert>
				{/if}
			</form>
		{:else}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="text-part" use:copyableCodeBlocks>{@html renderMarkdown(message.content)}</div>
		{/if}
	</div>
</article>

{#if showRawInput && conversationId && inputMessageId}
	<RawInputDialog
		{conversationId}
		messageId={inputMessageId}
		onClose={() => (showRawInput = false)}
	/>
{/if}

<style>
	.msg {
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border);
		border-left-width: 3px;
		background: var(--surface);
	}
	@media (max-width: 768px) {
		.msg {
			padding: var(--space-3) var(--space-3);
		}
	}
	.msg[data-role='user'] {
		background: var(--surface-2);
		border-left-color: var(--border);
	}
	.msg[data-role='assistant'] {
		border-left-color: var(--accent);
	}
	.msg[data-role='assistant'] .role {
		color: var(--accent);
	}
	.msg[data-role='system'] {
		background: transparent;
		border-style: dashed;
		opacity: 0.85;
	}
	header {
		margin-bottom: var(--space-2);
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.role {
		font-weight: 600;
	}
	.status {
		margin-left: var(--space-2);
	}
	.action-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.15rem 0.45rem;
		font: inherit;
		font-size: var(--fs-xs);
		text-transform: none;
		letter-spacing: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			background 0.12s ease,
			color 0.12s ease;
	}
	.action-btn:first-of-type {
		margin-left: auto;
	}
	.msg:hover .action-btn,
	.action-btn:focus-visible {
		opacity: 1;
	}
	.action-btn:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.action-btn:disabled {
		cursor: progress;
		opacity: 0.5;
	}
	.fork-badges {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-left: var(--space-1);
	}
	.fork-badge {
		display: inline-flex;
		text-decoration: none;
		max-width: 16em;
	}
	.fork-badge :global(.pill) {
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
	.fork-badge:hover :global(.pill) {
		color: var(--text);
		background: var(--surface-hover);
	}
	.fork-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.body :global(p:first-child) {
		margin-top: 0;
	}
	.body :global(p:last-child) {
		margin-bottom: 0;
	}
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.edit-form textarea {
		width: 100%;
		min-height: 4.5em;
		font: inherit;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: inherit;
		resize: vertical;
	}
	.edit-form textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.edit-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.edit-actions .hint {
		flex: 1;
		font-size: var(--fs-xs);
		min-width: 12em;
	}
</style>
