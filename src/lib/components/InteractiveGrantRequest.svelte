<script lang="ts">
	import { untrack } from 'svelte';
	import { isGrantTool, type GrantTool } from '$lib/permissions/metadata';
	import type { GrantScope } from '$lib/permissions/scope-types';
	import type { InteractivePermissionView, InteractiveResponse } from '$lib/types';
	// Shared with the Settings → Permissions grant form: GrantScopeEditor and its
	// PermissionGrantScopeFields renderer live in $lib/components so the in-chat
	// approval and the settings editor stay byte-for-byte identical.
	import GrantScopeEditor from './GrantScopeEditor.svelte';
	import { expiryChoiceToMs, type ExpiryChoice } from './interactive-permission';
	import Alert from './ui/Alert.svelte';

	let {
		request,
		onRespond
	}: {
		request: InteractivePermissionView & { requestId: string };
		onRespond: (r: InteractiveResponse) => void;
	} = $props();

	let busy = $state(false);
	let appliesTo = $state<'this-conversation' | 'all-conversations'>('this-conversation');
	let expiryChoice = $state<ExpiryChoice>('forever');
	let denialFeedback = $state(untrack(() => request.defaultDenyFeedback ?? ''));

	// The proposed grant seeds a fully-editable scope editor (the same one the
	// settings page uses), so the human can narrow or adjust the agent's request
	// before saving. `scopeJson` / `editedScope` / `scopeError` read the editor's
	// live build back out; what gets persisted is the EDITED scope, never the
	// agent's proposal verbatim.
	const grantRequest = $derived(request.grantRequest);
	const tool = $derived<GrantTool>(isGrantTool(request.tool) ? request.tool : 'shell');
	const seedScope = $derived<GrantScope | null>(grantRequest?.scope ?? null);
	let scopeJson = $state('');
	let editedScope = $state<GrantScope | null>(null);
	let scopeError = $state<string | null>(null);

	const denyAllPolicy = $derived(request.userPolicy === 'deny-all');
	const canSave = $derived(!denyAllPolicy && !!scopeJson && !!editedScope);

	async function pick(r: InteractiveResponse) {
		if (busy) return;
		busy = true;
		try {
			await onRespond(r);
		} finally {
			busy = false;
		}
	}

	function denyFeedback(): string | undefined {
		const trimmed = denialFeedback.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	function save() {
		if (!canSave || !editedScope) return;
		pick({
			kind: 'permission',
			decision: 'allow-always',
			scope: { permissionKind: tool, scope: editedScope },
			expiresInMs: expiryChoiceToMs(expiryChoice),
			applyToAllConversations: appliesTo === 'all-conversations'
		});
	}

	function deny() {
		const feedback = denyFeedback();
		pick(
			feedback
				? { kind: 'permission', decision: 'deny', feedback }
				: { kind: 'permission', decision: 'deny' }
		);
	}

	function previewSave(): string {
		const where =
			appliesTo === 'all-conversations' ? 'in every conversation' : 'in this conversation';
		const ttl =
			expiryChoice === '1h' ? ', for 1 hour' : expiryChoice === '1d' ? ', for 1 day' : ', forever';
		return `Save a ${tool} grant ${where}${ttl}.`;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (busy) return;
		if (e.currentTarget !== e.target) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			deny();
		}
	}
</script>

<div class="interactive" role="alertdialog" aria-modal="true" tabindex="-1" onkeydown={onKeyDown}>
	<div class="head">Permission grant requested</div>
	<div class="body">
		<div>
			<strong>{request.tool}</strong>
			<span class="muted">({request.permissionKind})</span>
		</div>

		{#if grantRequest?.reason}
			<div class="reason">
				<div class="muted small">Reason given by the agent</div>
				<p>{grantRequest.reason}</p>
			</div>
		{/if}

		<div class="muted small editor-hint">
			The agent proposed the scope below. Review it and narrow anything before saving — what you
			save here is what gets persisted, not the original request.
		</div>

		<GrantScopeEditor
			{tool}
			{seedScope}
			onChange={(r) => {
				scopeJson = r.json;
				editedScope = r.scope;
				scopeError = r.error;
			}}
		/>

		{#if scopeJson}
			<details class="args">
				<summary>Resulting scope (JSON)</summary>
				<pre>{scopeJson}</pre>
			</details>
		{:else if scopeError}
			<div class="err small">{scopeError}</div>
		{/if}

		<fieldset class="scope-group">
			<legend>Applies to</legend>
			<label class="scope-option">
				<input
					type="radio"
					name="grant-applies"
					value="this-conversation"
					checked={appliesTo === 'this-conversation'}
					onchange={() => (appliesTo = 'this-conversation')}
				/>
				Just this conversation
			</label>
			<label class="scope-option">
				<input
					type="radio"
					name="grant-applies"
					value="all-conversations"
					checked={appliesTo === 'all-conversations'}
					onchange={() => (appliesTo = 'all-conversations')}
				/>
				Every conversation (global)
			</label>
		</fieldset>

		<label class="expiry">
			Expires:
			<select
				value={expiryChoice}
				onchange={(e) =>
					(expiryChoice = (e.currentTarget as HTMLSelectElement).value as ExpiryChoice)}
			>
				<option value="forever">Never</option>
				<option value="1h">In 1 hour</option>
				<option value="1d">In 1 day</option>
			</select>
		</label>

		<label class="deny-feedback">
			<span>Optional feedback if you deny</span>
			<textarea
				bind:value={denialFeedback}
				maxlength="500"
				rows="3"
				disabled={busy}
				placeholder="Tell the agent why this is denied or what narrower scope to request..."
			></textarea>
			<span class="muted small">{denialFeedback.length}/500 characters</span>
		</label>
	</div>

	<div class="actions">
		<button class="btn" disabled={busy} onclick={deny} title="Esc">Deny</button>
		<button
			class="btn primary"
			disabled={busy || !canSave}
			onclick={save}
			title={denyAllPolicy
				? 'Your default policy is "Deny all" — change it in Settings before saving Allow grants.'
				: !scopeJson
					? 'Complete the scope fields above before saving.'
					: previewSave()}>Save grant</button
		>
	</div>

	<div class="preview muted small" aria-live="polite">
		<span><strong>Save grant</strong> → {previewSave()}</span>
		{#if denyAllPolicy}
			<Alert kind="warning">
				Default policy is <strong>Deny all</strong>; "Save grant" is disabled so it doesn't get
				silently dropped.
			</Alert>
		{/if}
	</div>
</div>

<style>
	.interactive {
		border: 1px solid var(--warning);
		background: var(--warning-bg);
		border-radius: var(--radius-lg);
		padding: var(--space-3) var(--space-4);
	}
	.head {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.reason {
		margin-top: 0.5rem;
		font-size: var(--fs-md);
	}
	.reason p {
		margin: 0.2rem 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.editor-hint {
		margin-top: 0.5rem;
	}
	.body :global(.scope-fields) {
		margin-top: 0.5rem;
	}
	.body details.args {
		margin-top: 0.5rem;
		font-size: var(--fs-md);
	}
	.body details.args > summary {
		cursor: pointer;
		opacity: 0.8;
	}
	.body details.args pre {
		margin-top: 0.3rem;
		max-height: 240px;
		overflow: auto;
		background: var(--surface);
	}
	.err {
		margin-top: 0.4rem;
		color: var(--danger);
	}
	.scope-group {
		display: flex;
		flex-direction: column;
		border: none;
		padding: 0;
		margin: 0.6rem 0 0;
		gap: 0.2rem;
	}
	.scope-group legend {
		font-weight: 600;
		padding: 0 0 0.2rem;
	}
	.scope-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: normal;
	}
	.expiry {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}
	.expiry select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
	}
	.deny-feedback {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.6rem;
		font-size: var(--fs-md);
	}
	.deny-feedback span:first-child {
		font-weight: 600;
	}
	.deny-feedback textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
		font: inherit;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	.preview {
		display: flex;
		flex-direction: column;
		margin-top: 0.4rem;
		gap: 0.15rem;
		font-size: var(--fs-sm);
		line-height: 1.35;
	}
</style>
