<script lang="ts">
	import { messageId } from '$lib/ids';
	import type { DisplayMessage } from '$lib/client/display-message';
	import { renderMarkdown } from '$lib/client/markdown';
	import { buildParts } from '$lib/client/message-parts';
	import { copyableCodeBlocks } from '$lib/client/copyable-code-blocks';
	import { zoomableImages } from '$lib/client/zoomable-images';
	import ToolCall from './ToolCall.svelte';
	import SubagentCall from './SubagentCall.svelte';
	import { isSubagentToolCall, selectSubagentChildren } from '$lib/client/subagent-display';
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
		message: DisplayMessage;
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

	// Editing is only possible for persisted user messages (an ephemeral
	// string id like `local-1234` is created optimistically before the server
	// confirms; we can't fork from those). It also requires the parent to
	// pass the conversation id. Forking is allowed while the source is busy,
	// but NOT on the user message that triggered the in-flight turn — that
	// is the live, streaming turn's boundary and editing it makes no sense.
	const canEdit = $derived(
		message.role === 'user' && !!conversationId && !isInFlightTurnUser && messageId.is(message.id)
	);

	// Assistant-message actions: regenerate the reply in place, or fork the
	// thread up to here into a new conversation. Both require a persisted
	// assistant message and the parent's conversation id. `error`-status
	// messages are included: a failed or empty turn (e.g. `empty_response`)
	// must offer Retry so the user can re-run it instead of being stranded on
	// a dead bubble. The regenerate endpoint accepts any assistant message and
	// re-runs from the preceding user prompt.
	const canAssistantActions = $derived(
		message.role === 'assistant' &&
			(message.status === 'complete' || message.status === 'error') &&
			!!conversationId &&
			typeof message.id === 'string'
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

	async function submitForkEdit(isolated = false) {
		const text = editText.trim();
		if (!text || !conversationId || submitting) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/fork`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text, ...(isolated ? { workspace: 'worktree' } : {}) })
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

	async function continueInNewConversation(isolated = false) {
		if (!conversationId || submitting) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/fork`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(isolated ? { workspace: 'worktree' } : {})
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

	const parts = $derived(
		buildParts({
			role: message.role,
			status: message.status,
			content: message.content ?? '',
			toolCalls: message.toolCalls,
			fileEdits: message.fileEdits,
			reasoningBlocks: message.reasoningBlocks,
			renderMarkdown
		})
	);
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
				onclick={() => continueInNewConversation()}
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
			<button
				type="button"
				class="action-btn fork-btn"
				onclick={() => continueInNewConversation(true)}
				disabled={submitting}
				title="Clone this conversation into an isolated worktree at this snapshot"
				aria-label="Continue from here in an isolated worktree"
			>
				Worktree fork
			</button>
		{/if}
	</header>
	<div class="body">
		{#if message.role === 'assistant'}
			{#each parts as p, i (i)}
				{#if p.kind === 'text'}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="text-part" use:copyableCodeBlocks use:zoomableImages>{@html p.html}</div>
				{:else if p.kind === 'tool'}
					{@const children = selectSubagentChildren(
						{
							tools: message.toolCalls ?? [],
							reasoning: message.reasoningBlocks ?? [],
							edits: message.fileEdits ?? []
						},
						p.tool.id
					)}
					{#if isSubagentToolCall(p.tool)}
						<SubagentCall
							toolCall={p.tool}
							{conversationId}
							canRetry={canRetryMemory}
							onRetryStarted={onMemoryRetryStarted}
							childTools={children.tools}
							childReasoning={children.reasoning}
							childEdits={children.edits}
							allTools={message.toolCalls ?? []}
							allReasoning={message.reasoningBlocks ?? []}
							allEdits={message.fileEdits ?? []}
						/>
					{:else}
						<ToolCall toolCall={p.tool} {conversationId} onRerunStarted={onToolRerunStarted} />
					{/if}
				{:else if p.kind === 'reasoning'}
					<ReasoningBlock
						text={p.block.text}
						streaming={p.streaming}
						durationMs={p.block.durationMs}
						lazy={p.block.textTruncated && conversationId
							? { conversationId, reasoningBlockId: p.block.id, bytes: p.block.textBytes }
							: null}
					/>
				{:else}
					<DiffView
						path={p.edit.path}
						diff={p.edit.diff}
						// D8: transcript file-edit diffs are lazy sections — the
						// collapsed card shows path + diffstat, the full diff
						// hydrates on expand.
						collapsible={true}
						collapsedByDefault={true}
						lazy={p.edit.diffTruncated && conversationId
							? { conversationId, fileEditId: p.edit.id, bytes: p.edit.diffBytes }
							: null}
					/>
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
					<button
						type="button"
						class="btn secondary"
						disabled={submitting || !editText.trim()}
						onclick={() => submitForkEdit(true)}
						title="Create an isolated worktree at this message's snapshot"
					>
						Fork in worktree
					</button>
				</div>
			</form>
		{:else}
			<div class="text-part" use:copyableCodeBlocks use:zoomableImages>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html renderMarkdown(message.content)}
			</div>
		{/if}
		{#if errorMsg}
			<Alert kind="error">{errorMsg}</Alert>
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
	.text-part :global(img) {
		display: block;
		max-width: 100%;
		height: auto;
		max-height: 24em;
		object-fit: contain;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
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
