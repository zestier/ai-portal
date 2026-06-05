<script lang="ts">
	import {
		authLabel,
		formatContextWindow,
		type FormResult,
		type ProviderStatus,
		type SettingsData
	} from './settings-types';
	import {
		BACKEND_PROVIDER_IDS,
		type BackendProviderId,
		type ProviderRuntimeFeatureStatus,
		type SessionMode
	} from '$lib/types';

	const CUSTOM_MODEL_OPTION = '__custom__';

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
		},
		{
			value: 'best-effort',
			label: 'Best effort',
			hint: 'Autopilot-style execution, but permission prompts auto-reject with feedback.'
		}
	];

	let {
		settings,
		providers,
		form
	}: {
		settings: SettingsData;
		providers: ProviderStatus[];
		form: FormResult | null;
	} = $props();

	let selectedProvider = $state<BackendProviderId>(BACKEND_PROVIDER_IDS[0]);
	let selectedModelChoice = $state('');
	let customModel = $state('');
	$effect(() => {
		selectedProvider = settings.defaultProvider;
	});
	const selectedProviderStatus = $derived(
		providers.find((provider) => provider.id === selectedProvider) ?? providers[0]
	);
	const modeFeature = $derived(selectedProviderStatus.capabilities.features.modes);
	const runtimeModesSupported = $derived(
		modeFeature.supported && modeFeature.behavior === 'supported'
	);
	const unavailableRuntimeFeatures = $derived(
		Object.values(selectedProviderStatus.capabilities.features).filter(
			(feature): feature is ProviderRuntimeFeatureStatus =>
				!feature.supported || feature.behavior === 'no-op'
		)
	);

	$effect(() => {
		const savedModel = settings.defaultModel ?? '';
		const modelIds = new Set(selectedProviderStatus.models.map((model) => model.id));
		if (!savedModel || modelIds.has(savedModel)) {
			selectedModelChoice = savedModel;
			customModel = '';
		} else {
			selectedModelChoice = CUSTOM_MODEL_OPTION;
			customModel = savedModel;
		}
	});

	function selectedModelFormValue(): string {
		return selectedModelChoice === CUSTOM_MODEL_OPTION ? customModel : selectedModelChoice;
	}

	function modelAvailability(provider: ProviderStatus): string {
		if (!provider.statusChecked) return 'Not checked; save this provider as the default to check';
		if (!provider.capabilities.modelList) return 'Model discovery unsupported';
		if (provider.models.length > 0) return `${provider.models.length} model(s) available`;
		if (provider.error) return `Model discovery failed: ${provider.error}`;
		return 'No models reported; enter a model id manually';
	}

	function featureTone(feature: ProviderRuntimeFeatureStatus): 'ok' | 'warn' | 'bad' {
		if (feature.supported) return 'ok';
		return feature.behavior === 'no-op' ? 'warn' : 'bad';
	}
</script>

<div
	id="settings-panel-general"
	class="tab-panel general"
	role="tabpanel"
	aria-labelledby="settings-tab-general"
>
	<div class="section-heading">
		<h2>General</h2>
		<p class="muted small">Defaults for new conversations and your portal account.</p>
	</div>

	<section class="backend-status" aria-labelledby="backend-status-heading">
		<div class="section-subheading">
			<h3 id="backend-status-heading">Backend status</h3>
			<p class="muted small">
				Status is read from the configured provider endpoints. Save defaults below for newly created
				conversations.
			</p>
		</div>
		<div class="provider-grid">
			{#each providers as provider (provider.id)}
				<article
					class="provider-card"
					class:selected={provider.id === selectedProvider}
					class:ok={provider.statusChecked && provider.auth.isAuthenticated}
					class:bad={provider.statusChecked && !provider.auth.isAuthenticated}
				>
					<div class="provider-card-header">
						<strong>{provider.displayName}</strong>
						<span
							class="status-pill"
							class:ok={provider.statusChecked && provider.auth.isAuthenticated}
						>
							{!provider.statusChecked
								? 'Not selected'
								: provider.auth.isAuthenticated
									? 'Configured'
									: 'Needs setup'}
						</span>
					</div>
					<dl>
						<div>
							<dt class="eyebrow">Auth</dt>
							<dd>{authLabel(provider.auth)}</dd>
						</div>
						<div>
							<dt class="eyebrow">Models</dt>
							<dd>{modelAvailability(provider)}</dd>
						</div>
						{#if provider.auth.statusMessage}
							<div>
								<dt class="eyebrow">Status</dt>
								<dd>{provider.auth.statusMessage}</dd>
							</div>
						{/if}
					</dl>
					{#if provider.ui.setupHint && (provider.ui.setupHintVisibility === 'always' || (provider.statusChecked && !provider.auth.isAuthenticated))}
						<p class="muted small">
							{provider.ui.setupHint}
						</p>
					{/if}
				</article>
			{/each}
		</div>
	</section>

	<form method="POST" action="?/save" class="settings-form">
		<label>
			Default provider
			<select name="defaultProvider" bind:value={selectedProvider}>
				{#each providers as provider (provider.id)}
					<option value={provider.id}>{provider.displayName}</option>
				{/each}
			</select>
			<span class="muted small">
				Applies to newly created conversations. Existing conversations keep their provider.
			</span>
		</label>
		<label>
			Default model
			{#if selectedProviderStatus.models.length > 0}
				<input type="hidden" name="defaultModel" value={selectedModelFormValue()} />
				<select bind:value={selectedModelChoice}>
					<option value="">(use server default)</option>
					{#each selectedProviderStatus.models as m (m.id)}
						<option value={m.id}>
							{m.name} — {m.id} ({formatContextWindow(m.maxContextWindowTokens)})
						</option>
					{/each}
					<option value={CUSTOM_MODEL_OPTION}>Enter a custom model id…</option>
				</select>
				{#if selectedModelChoice === CUSTOM_MODEL_OPTION}
					<input
						bind:value={customModel}
						placeholder={selectedProviderStatus.ui.defaultModelPlaceholder}
						aria-label="Custom default model id"
					/>
				{/if}
				<span class="muted small">
					Pick a discovered model or enter an exact model id accepted by the selected provider.
				</span>
			{:else}
				<input
					name="defaultModel"
					value={settings.defaultModel ?? ''}
					placeholder={selectedProviderStatus.ui.defaultModelPlaceholder}
				/>
				<span class="muted small">
					Model list unavailable{selectedProviderStatus.error
						? `: ${selectedProviderStatus.error}`
						: ''}.
				</span>
			{/if}
		</label>
		{#if unavailableRuntimeFeatures.length > 0}
			<section class="feature-note" aria-labelledby="provider-feature-heading">
				<div class="section-subheading">
					<h3 id="provider-feature-heading">
						{selectedProviderStatus.displayName} feature differences
					</h3>
					<p class="muted small">
						These defaults still save in the portal, but provider runtime support varies.
					</p>
				</div>
				<ul>
					{#each unavailableRuntimeFeatures as feature (feature.label)}
						<li data-tone={featureTone(feature)}>
							<strong>{feature.label}</strong>
							<span>{feature.description}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
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
				{#if runtimeModesSupported}
					{MODE_OPTIONS.find((opt) => opt.value === settings.defaultConversationMode)?.hint}
				{:else}
					{modeFeature.description}
				{/if}
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
			<select name="theme" value={settings.theme}>
				<option value="system">System</option>
				<option value="dark">Dark</option>
				<option value="light">Light</option>
			</select>
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
	}
	.section-heading {
		margin-bottom: 1rem;
	}
	.section-heading h2 {
		margin: 0 0 0.25rem;
		font-size: var(--fs-2xl);
	}
	.section-heading p {
		margin: 0;
	}
	.section-subheading {
		margin-bottom: 0.75rem;
	}
	.section-subheading h3 {
		margin: 0 0 0.25rem;
		font-size: var(--fs-lg);
	}
	.section-subheading p {
		margin: 0;
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
		color: var(--danger, #d33);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.logout-form {
		display: block;
		margin-bottom: 0;
	}
	.backend-status,
	.feature-note {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem 1rem;
		margin-bottom: 1.5rem;
	}
	.provider-grid {
		display: grid;
		gap: 0.75rem;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	}
	.provider-card {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem;
		background: color-mix(in srgb, var(--surface) 88%, transparent);
	}
	.provider-card.selected {
		border-color: var(--accent);
	}
	.provider-card.ok {
		box-shadow: inset 3px 0 0 var(--success);
	}
	.provider-card.bad {
		box-shadow: inset 3px 0 0 var(--danger);
	}
	.provider-card-header {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		align-items: center;
	}
	.status-pill {
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: var(--fs-xs);
		padding: 0.15rem 0.45rem;
		white-space: nowrap;
	}
	.status-pill.ok {
		border-color: var(--success);
		color: var(--success);
	}
	dl {
		display: grid;
		gap: 0.35rem;
		margin: 0.75rem 0;
	}
	dl > div {
		display: grid;
		gap: 0.15rem;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.feature-note {
		margin-top: 0.25rem;
	}
	.feature-note ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.feature-note li {
		border-left: 3px solid var(--border);
		padding-left: 0.65rem;
		display: grid;
		gap: 0.15rem;
	}
	.feature-note li[data-tone='ok'] {
		border-left-color: var(--success);
	}
	.feature-note li[data-tone='warn'] {
		border-left-color: var(--warning, #d29922);
	}
	.feature-note li[data-tone='bad'] {
		border-left-color: var(--danger);
	}
	.small {
		font-size: var(--fs-md);
	}
</style>
