<script lang="ts">
	import type { LaunchWorkspaceKind, TemplateLaunchOptions } from '$lib/prompt-templates';
	import type { ApprovalMode, SessionMode } from '$lib/types';
	import { PORTAL_TOOL_GROUPS, type PortalToolGroupId } from '$lib/tools/groups';
	import { untrack } from 'svelte';
	import Modal from './ui/Modal.svelte';

	let {
		open = false,
		templateTitle,
		defaults,
		busy = false,
		error = null,
		onLaunch,
		onCancel
	}: {
		/** Whether the review dialog is shown. */
		open?: boolean;
		/** Template being launched, named in the dialog copy. */
		templateTitle?: string | undefined;
		/** Initial values, taken from the template's stored settings. */
		defaults: TemplateLaunchOptions;
		/** Disable the form while the launch is in flight. */
		busy?: boolean;
		/** Launch failure to surface without closing the dialog. */
		error?: string | null;
		onLaunch: (options: TemplateLaunchOptions) => void;
		onCancel: () => void;
	} = $props();

	const title = 'Review before sending';

	// Seeded from `defaults` without tracking it here (the $effect below re-seeds
	// on every new launch), so this is a genuine one-time initial value.
	let prompt = $state(untrack(() => defaults.prompt));
	let workspace = $state<LaunchWorkspaceKind>(untrack(() => defaults.workspace));
	let conversationMode = $state<string>(untrack(() => defaults.conversationMode ?? ''));
	let approvalMode = $state<string>(untrack(() => defaults.approvalMode ?? ''));
	let model = $state<string>(untrack(() => defaults.model ?? ''));
	let disabledToolGroups = $state<PortalToolGroupId[]>(untrack(() => defaults.disabledToolGroups));

	// Re-seed whenever a different launch opens the dialog so a second launch
	// never inherits the previous one's edits.
	$effect(() => {
		prompt = defaults.prompt;
		workspace = defaults.workspace;
		conversationMode = defaults.conversationMode ?? '';
		approvalMode = defaults.approvalMode ?? '';
		model = defaults.model ?? '';
		disabledToolGroups = defaults.disabledToolGroups;
	});

	function toggleDisabledGroup(id: PortalToolGroupId) {
		disabledToolGroups = disabledToolGroups.includes(id)
			? disabledToolGroups.filter((group) => group !== id)
			: [...disabledToolGroups, id];
	}

	// The model list is not discoverable without the provider layer; the select
	// offers the template's stored override (kept so reviewing a launch never
	// silently drops it) or the server default.
	const modelChoices = $derived.by(() => {
		const ids: string[] = [];
		if (model) ids.push(model);
		return ids;
	});

	const conversationModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Use my default mode' },
		{ value: 'interactive', label: 'Interactive' },
		{ value: 'autopilot', label: 'Autopilot' }
	];

	const approvalModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Use my default approvals' },
		{ value: 'ask', label: 'Ask every time' },
		{ value: 'auto-approve', label: 'Auto-approve prompts' },
		{ value: 'auto-deny', label: 'Auto-deny prompts (best effort)' }
	];

	function launch() {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		onLaunch({
			prompt: trimmed,
			workspace,
			conversationMode: (conversationMode || null) as SessionMode | null,
			approvalMode: (approvalMode || null) as ApprovalMode | null,
			model: model || null,
			disabledToolGroups
		});
	}
</script>

<Modal {open} onClose={onCancel} ariaLabel={title} width="min(680px, 100%)">
	<div class="review">
		<div>
			<p class="eyebrow">
				{templateTitle ? `Launching “${templateTitle}”` : 'Launching a template'}
			</p>
			<h2>{title}</h2>
		</div>
		<p class="muted small">
			Edit the prompt and the launch settings. Nothing is created until you launch.
		</p>

		{#if error}
			<p class="review-error" role="alert">{error}</p>
		{/if}

		<label>
			Prompt
			<textarea bind:value={prompt} rows="10" disabled={busy}></textarea>
		</label>

		<div class="fields">
			<label>
				Git workspace
				<select bind:value={workspace} disabled={busy}>
					<option value="shared">Shared checkout</option>
					<option value="worktree">New isolated worktree</option>
				</select>
			</label>
			<label>
				Conversation mode
				<select bind:value={conversationMode} disabled={busy}>
					{#each conversationModeOptions as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</label>
			<label>
				Approvals
				<select bind:value={approvalMode} disabled={busy}>
					{#each approvalModeOptions as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</label>
			<label>
				Model
				<select bind:value={model} disabled={busy}>
					<option value="">Use my default model</option>
					{#each modelChoices as modelId (modelId)}
						<option value={modelId}>{modelId}</option>
					{/each}
				</select>
			</label>
		</div>

		<fieldset class="tool-groups-fieldset" disabled={busy}>
			<legend>Portal tool groups</legend>
			<p class="muted small">
				Unchecked groups are disabled up front in this chat (a seed — the chat can re-enable them).
				Checked groups stay available. Native CLI tools (bash, view, edit…) are always available and
				unaffected.
			</p>
			<div class="tool-groups-checks">
				{#each PORTAL_TOOL_GROUPS as group (group.id)}
					<label class="checkbox" title={group.hint}>
						<input
							type="checkbox"
							checked={!disabledToolGroups.includes(group.id)}
							onchange={() => toggleDisabledGroup(group.id)}
							disabled={busy}
						/>
						{group.label}
					</label>
				{/each}
			</div>
		</fieldset>

		<div class="actions">
			<button type="button" class="btn sm ghost" onclick={onCancel} disabled={busy}>Cancel</button>
			<button
				type="button"
				class="btn sm primary"
				onclick={launch}
				disabled={busy || prompt.trim().length === 0}
			>
				{busy ? 'Launching...' : 'Launch chat'}
			</button>
		</div>
	</div>
</Modal>

<style>
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	h2,
	.eyebrow {
		margin: 0;
	}
	h2 {
		font-size: var(--fs-lg);
	}
	.muted {
		margin: 0;
		color: var(--text-muted);
	}
	label {
		display: grid;
		gap: 0.35rem;
		font-size: var(--fs-sm);
		min-width: 0;
	}
	textarea {
		width: 100%;
		font: inherit;
		resize: vertical;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-3);
	}
	.tool-groups-fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		display: grid;
		gap: var(--space-2);
		min-width: 0;
	}
	.tool-groups-fieldset legend {
		font-size: var(--fs-sm);
		font-weight: 600;
		padding: 0 var(--space-2);
	}
	.tool-groups-checks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: var(--space-2);
	}
	.checkbox {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.checkbox input {
		width: auto;
	}
	.review-error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-sm);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
