<script lang="ts">
	import type { LaunchWorkspaceKind, TemplateLaunchOptions } from '$lib/prompt-templates';
	import type { SessionMode } from '$lib/types';
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
	let model = $state<string>(untrack(() => defaults.model ?? ''));

	// Re-seed whenever a different launch opens the dialog so a second launch
	// never inherits the previous one's edits.
	$effect(() => {
		prompt = defaults.prompt;
		workspace = defaults.workspace;
		conversationMode = defaults.conversationMode ?? '';
		model = defaults.model ?? '';
	});

	// Model ids are fetched lazily (the provider probe is not cheap) and only
	// once the dialog is actually opened. A failure degrades to "default model"
	// plus whatever the template already stored.
	let models = $state<string[] | null>(null);
	let loadingModels = $state(false);

	$effect(() => {
		if (!open || models || loadingModels) return;
		loadingModels = true;
		void (async () => {
			try {
				const res = await fetch('/api/providers/status');
				const body = res.ok ? await res.json() : null;
				const ids = Array.isArray(body?.models)
					? body.models.map((m: { id?: unknown }) => String(m?.id ?? '')).filter(Boolean)
					: [];
				models = ids;
			} catch {
				models = [];
			} finally {
				loadingModels = false;
			}
		})();
	});

	// Always offer the currently selected id, even when the provider no longer
	// lists it, so reviewing a stale override doesn't silently drop it.
	const modelChoices = $derived.by(() => {
		const ids = [...(models ?? [])];
		if (model && !ids.includes(model)) ids.unshift(model);
		return ids;
	});

	const conversationModeOptions: { value: string; label: string }[] = [
		{ value: '', label: 'Use my default mode' },
		{ value: 'interactive', label: 'Interactive' },
		{ value: 'plan', label: 'Plan' },
		{ value: 'autopilot', label: 'Autopilot' },
		{ value: 'best-effort', label: 'Best effort' }
	];

	function launch() {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		onLaunch({
			prompt: trimmed,
			workspace,
			conversationMode: (conversationMode || null) as SessionMode | null,
			model: model || null
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
				Model
				<select bind:value={model} disabled={busy}>
					<option value="">{loadingModels ? 'Loading models...' : 'Use my default model'}</option>
					{#each modelChoices as modelId (modelId)}
						<option value={modelId}>{modelId}</option>
					{/each}
				</select>
			</label>
		</div>

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
