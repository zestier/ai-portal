<script lang="ts">
	import { type FormResult, type SettingsData } from './settings-types';
	import { THEME_ACCENTS, type ApprovalMode, type SessionMode, type ThemeAccent } from '$lib/types';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import { applyLiveThemePreference, type ThemeMode } from '$lib/client/theme-preview';

	const MODE_OPTIONS: { value: SessionMode; label: string; hint: string }[] = [
		{
			value: 'interactive',
			label: 'Interactive',
			hint: 'Normal chat; tools prompt for permission.'
		},
		{
			value: 'plan',
			label: 'Plan',
			hint: 'Plan-only; destructive tools stay blocked until the agent exits plan mode.'
		},
		{
			value: 'autopilot',
			label: 'Autopilot',
			hint: 'The agent can work for longer stretches with less supervision.'
		}
	];

	const APPROVAL_MODE_OPTIONS: { value: ApprovalMode; label: string; hint: string }[] = [
		{
			value: 'ask',
			label: 'Ask every time',
			hint: 'Tool calls not covered by a grant or your policy raise a permission dialog.'
		},
		{
			value: 'auto-approve',
			label: 'Auto-approve prompts',
			hint: 'Prompt-worthy tool calls are approved without asking; each one is audited as auto-allow.'
		},
		{
			value: 'auto-deny',
			label: 'Auto-deny prompts (best effort)',
			hint: 'Permission prompts are auto-rejected with feedback instead of waiting for you.'
		}
	];

	let {
		settings,
		form
	}: {
		settings: SettingsData;
		form: FormResult | null;
	} = $props();

	// svelte-ignore state_referenced_locally
	let selectedTheme = $state<ThemeMode>(settings.theme);
	// svelte-ignore state_referenced_locally
	let selectedAccent = $state<ThemeAccent>(settings.accent);
	$effect(() => {
		selectedTheme = settings.theme;
		selectedAccent = settings.accent;
	});
	$effect(() => {
		return applyLiveThemePreference({
			theme: selectedTheme,
			accent: selectedAccent,
			fallbackTheme: settings.theme,
			fallbackAccent: settings.accent
		});
	});
</script>

<div
	id="settings-panel-general"
	class="tab-panel general"
	role="tabpanel"
	aria-labelledby="settings-tab-general"
>
	<PanelHeader title="General" fullBleed>
		{#snippet meta()}Defaults for new conversations and your portal account.{/snippet}
	</PanelHeader>

	<form method="POST" action="?/save" class="settings-form">
		<label>
			Default model
			<input
				name="defaultModel"
				value={settings.defaultModel ?? ''}
				placeholder="(server default) — provider/model id"
			/>
			<span class="muted small">
				Seeds the model id for newly created conversations, in the <code>provider/model</code> form the
				pi runtime expects. Leave blank to use the server default.
			</span>
		</label>
		<label>
			Default working directory
			<input
				name="defaultWorkdir"
				value={settings.defaultWorkdir ?? ''}
				placeholder="(blank = PROJECT_ROOT)"
			/>
		</label>
		<label>
			Default conversation mode
			<select name="defaultConversationMode" value={settings.defaultConversationMode}>
				{#each MODE_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<span class="muted small">
				Applies to newly created conversations. Existing conversations keep their current mode.
				<br />
				{MODE_OPTIONS.find((opt) => opt.value === settings.defaultConversationMode)?.hint}
			</span>
		</label>
		<label>
			Default approval mode
			<select name="defaultApprovalMode" value={settings.defaultApprovalMode}>
				{#each APPROVAL_MODE_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<span class="muted small">
				Applies to newly created conversations; each conversation can change it in its header.
				<br />
				{APPROVAL_MODE_OPTIONS.find((opt) => opt.value === settings.defaultApprovalMode)?.hint}
			</span>
		</label>
		<label>
			Permission policy
			<select name="defaultPolicy" value={settings.defaultPolicy}>
				<option value="prompt"
					>Auto-allow file ops inside the workspace, prompt otherwise (default)</option
				>
				<option value="allow-all">Allow all (dangerous)</option>
				<option value="deny-all">Deny all</option>
			</select>
		</label>
		<label>
			Theme
			<select name="theme" bind:value={selectedTheme}>
				<option value="system">System</option>
				<option value="dark">Dark</option>
				<option value="light">Light</option>
			</select>
		</label>
		<label>
			Accent color
			<select name="accent" bind:value={selectedAccent}>
				{#each THEME_ACCENTS as accent (accent.value)}
					<option value={accent.value}>{accent.label}</option>
				{/each}
			</select>
			<span class="muted small">
				Tints buttons, links, highlights and the favicon. Handy for telling apart multiple portal
				copies at a glance. Applies on top of the light/dark theme.
			</span>
		</label>

		<div class="form-actions">
			<button class="btn primary" type="submit">Save</button>
			{#if form?.formId === 'save' && form.ok}<span class="ok">Saved.</span>{/if}
			{#if form?.formId === 'save' && form.error}<span class="err">{form.error}</span>{/if}
		</div>
	</form>

	<form method="POST" action="/logout" class="logout-form">
		<button class="btn">Log out</button>
	</form>
</div>

<style>
	.tab-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		overflow: hidden;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-bottom: 1.25rem;
	}
	form input,
	form select {
		width: 100%;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.form-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.err {
		color: var(--danger);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.logout-form {
		display: block;
		margin-bottom: 0;
	}
	.small {
		font-size: var(--fs-md);
	}
</style>
