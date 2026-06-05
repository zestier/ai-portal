<script lang="ts">
	import type { TurnInput } from '$lib/types';
	import Modal from './ui/Modal.svelte';

	let {
		conversationId,
		messageId,
		onClose
	}: {
		conversationId: string;
		messageId: string;
		onClose: () => void;
	} = $props();

	let loading = $state(true);
	let errorMsg = $state<string | null>(null);
	let input = $state<TurnInput | null>(null);
	let copied = $state(false);

	async function load() {
		loading = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${messageId}`);
			if (!r.ok) {
				errorMsg = (await r.text()) || `Failed to load input (${r.status})`;
				return;
			}
			const data = (await r.json()) as { input: TurnInput | null };
			input = data.input;
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function copyFull() {
		if (!input) return;
		try {
			await navigator.clipboard.writeText(input.fullInput);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard unavailable; ignore */
		}
	}

	$effect(() => {
		void load();
	});

	const hasPrelude = $derived(!!input && input.prelude.trim().length > 0);
</script>

<Modal
	open
	{onClose}
	labelledby="raw-input-title"
	width="min(820px, 100%)"
	maxHeight="min(820px, 90vh)"
>
	<header>
		<div>
			<p class="eyebrow">Turn input</p>
			<h2 id="raw-input-title">Full input sent to the provider</h2>
		</div>
		<button class="btn icon ghost sm" type="button" aria-label="Close" onclick={onClose}>×</button>
	</header>

	<p class="muted small">
		Exactly what the model received for this turn — the auto-injected portal prelude, any memory or
		prior-message context, and your raw message.
	</p>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if errorMsg}
		<p class="err" role="alert">{errorMsg}</p>
	{:else if !input}
		<p class="muted">
			No captured input for this message. Inputs are recorded for turns started after this feature
			shipped.
		</p>
	{:else}
		<dl class="meta">
			{#if input.provider}
				<div>
					<dt class="eyebrow">Provider</dt>
					<dd>{input.provider}</dd>
				</div>
			{/if}
			{#if input.model}
				<div>
					<dt class="eyebrow">Model</dt>
					<dd>{input.model}</dd>
				</div>
			{/if}
			{#if input.mode}
				<div>
					<dt class="eyebrow">Mode</dt>
					<dd>{input.mode}</dd>
				</div>
			{/if}
			{#if input.memoryMode}
				<div>
					<dt class="eyebrow">Memory</dt>
					<dd>{input.memoryMode}</dd>
				</div>
			{/if}
			<div>
				<dt class="eyebrow">Prelude</dt>
				<dd>{hasPrelude ? 'applied' : 'none'}</dd>
			</div>
		</dl>

		<div class="section-row">
			<h3>Full input</h3>
			<button class="btn sm ghost" type="button" onclick={copyFull}>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</div>
		<pre class="dump">{input.fullInput}</pre>

		{#if input.initialMessages && input.initialMessages.length > 0}
			<h3>Embedded prior messages ({input.initialMessages.length})</h3>
			<p class="muted small">
				Sent as conversation history for providers that can't resume a server session.
			</p>
			<div class="prior">
				{#each input.initialMessages as m, i (i)}
					<div class="prior-msg">
						<span class="prior-role eyebrow">{m.role}</span>
						<pre class="dump">{m.content}</pre>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</Modal>

<style>
	header,
	.section-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: flex-start;
	}
	h2 {
		margin: 0;
	}
	h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--fs-md);
	}
	.eyebrow {
		margin: 0;
	}
	.small {
		font-size: var(--fs-sm);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: var(--space-3) 0 0;
	}
	.meta div {
		display: flex;
		gap: var(--space-1);
		align-items: baseline;
	}
	.meta dt {
		margin: 0;
	}
	.meta dd {
		margin: 0;
		font-weight: 600;
	}
	.dump {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--fs-sm);
		max-height: 40vh;
		overflow: auto;
	}
	.prior {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.prior-msg {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.err {
		margin: var(--space-2) 0 0;
		color: var(--danger);
		font-size: var(--fs-sm);
	}
</style>
