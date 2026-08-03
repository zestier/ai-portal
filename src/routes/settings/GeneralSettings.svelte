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
		THEME_ACCENTS,
		type ApprovalMode,
		type BackendProviderId,
		type MemoryExtractorBackend,
		type ProviderRuntimeFeatureStatus,
		type SessionMode,
		type ThemeAccent
	} from '$lib/types';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import Pill from '$lib/components/ui/Pill.svelte';
	import { applyLiveThemePreference, type ThemeMode } from '$lib/client/theme-preview';

	const CUSTOM_MODEL_OPTION = '__custom__';
	const DEFAULT_EXTRACTOR_OPTION = '';

	const EXTRACTOR_BACKEND_OPTIONS: { value: MemoryExtractorBackend; label: string }[] = [
		{ value: 'heuristic', label: 'Heuristic (local)' },
		{ value: 'openai-compatible', label: 'OpenAI-compatible (single-shot)' },
		{ value: 'openai-compatible-tools', label: 'OpenAI-compatible (tools)' }
	];

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
	let selectedExtractorBackend = $state<MemoryExtractorBackend | ''>('');
	let selectedExtractorModelChoice = $state('');
	let customExtractorModel = $state('');
	// '' means "same backend as the conversation itself" — the default, and the
	// reason a single-backend deployment can run the reviewer at all.
	let selectedAdversaryBackend = $state('');
	let selectedAdversaryModelChoice = $state('');
	let customAdversaryModel = $state('');
	// svelte-ignore state_referenced_locally
	let selectedTheme = $state<ThemeMode>(settings.theme);
	// svelte-ignore state_referenced_locally
	let selectedAccent = $state<ThemeAccent>(settings.accent);
	$effect(() => {
		selectedProvider = settings.defaultProvider;
	});
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
	$effect(() => {
		selectedExtractorBackend = settings.defaultMemoryExtractorBackend ?? '';
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

	$effect(() => {
		const savedExtractorModel = settings.defaultMemoryExtractorModel ?? '';
		const modelIds = new Set(selectedProviderStatus.models.map((model) => model.id));
		if (!savedExtractorModel || modelIds.has(savedExtractorModel)) {
			selectedExtractorModelChoice = savedExtractorModel;
			customExtractorModel = '';
		} else {
			selectedExtractorModelChoice = CUSTOM_MODEL_OPTION;
			customExtractorModel = savedExtractorModel;
		}
	});

	function selectedModelFormValue(): string {
		return selectedModelChoice === CUSTOM_MODEL_OPTION ? customModel : selectedModelChoice;
	}

	function selectedExtractorModelFormValue(): string {
		return selectedExtractorModelChoice === CUSTOM_MODEL_OPTION
			? customExtractorModel
			: selectedExtractorModelChoice;
	}

	// Only backends that can serve an out-of-band completion can host the
	// reviewer. Offering one that cannot would produce a settings page that
	// saves cleanly and then silently records nothing but error rows.
	const adversaryBackendOptions = $derived(
		providers.filter((provider) => provider.capabilities.sideCompletion)
	);
	// When the backend is left as "same as the conversation", the model has to be
	// typed: which backend's namespace it belongs to is only known per
	// conversation, so there is no single list to pick from.
	const adversaryProviderStatus = $derived(
		selectedAdversaryBackend
			? (providers.find((provider) => provider.id === selectedAdversaryBackend) ?? null)
			: null
	);

	$effect(() => {
		selectedAdversaryBackend = settings.defaultAdversaryBackend ?? '';
	});

	$effect(() => {
		const saved = settings.defaultAdversaryModel ?? '';
		const modelIds = new Set((adversaryProviderStatus?.models ?? []).map((model) => model.id));
		if (saved && !modelIds.has(saved)) {
			selectedAdversaryModelChoice = CUSTOM_MODEL_OPTION;
			customAdversaryModel = saved;
		} else {
			selectedAdversaryModelChoice = saved;
			customAdversaryModel = '';
		}
	});

	function selectedAdversaryModelFormValue(): string {
		return selectedAdversaryModelChoice === CUSTOM_MODEL_OPTION
			? customAdversaryModel
			: selectedAdversaryModelChoice;
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
	<PanelHeader title="General" fullBleed>
		{#snippet meta()}Defaults for new conversations and your portal account.{/snippet}
	</PanelHeader>

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
						<Pill
							tone={provider.statusChecked && provider.auth.isAuthenticated ? 'success' : 'neutral'}
						>
							{!provider.statusChecked
								? 'Not selected'
								: provider.auth.isAuthenticated
									? 'Configured'
									: 'Needs setup'}
						</Pill>
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
			Context window tier
			<select name="defaultContextTier" value={settings.defaultContextTier ?? ''}>
				<option value="">(use server default)</option>
				<option value="default">Standard (~200k)</option>
				<option value="long_context">Long context (1M)</option>
			</select>
			<span class="muted small">
				Applies the next time a Copilot session opens, including existing conversations. Long
				context is a premium, separately-billed tier and must also be enabled for your account;
				newer Copilot CLIs only grant the large window when it is explicitly requested.
			</span>
		</label>
		<label>
			Default memory harvester backend
			<select name="defaultMemoryExtractorBackend" bind:value={selectedExtractorBackend}>
				<option value={DEFAULT_EXTRACTOR_OPTION}>(use server default)</option>
				{#each EXTRACTOR_BACKEND_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<span class="muted small">
				Seeds the memory extractor backend for newly created conversations. Existing conversations
				keep their current backend.
				{#if selectedExtractorBackend === 'openai-compatible' || selectedExtractorBackend === 'openai-compatible-tools'}
					<br />
					Requires <code>OPENAI_COMPATIBLE_BASE_URL</code> and a harvester model; otherwise extraction
					falls back to the heuristic backend.
				{/if}
			</span>
		</label>
		<label>
			Default memory harvester model
			{#if selectedProviderStatus.models.length > 0}
				<input
					type="hidden"
					name="defaultMemoryExtractorModel"
					value={selectedExtractorModelFormValue()}
				/>
				<select bind:value={selectedExtractorModelChoice}>
					<option value="">(use server default)</option>
					{#each selectedProviderStatus.models as m (m.id)}
						<option value={m.id}>
							{m.name} — {m.id} ({formatContextWindow(m.maxContextWindowTokens)})
						</option>
					{/each}
					<option value={CUSTOM_MODEL_OPTION}>Enter a custom model id…</option>
				</select>
				{#if selectedExtractorModelChoice === CUSTOM_MODEL_OPTION}
					<input
						bind:value={customExtractorModel}
						placeholder={selectedProviderStatus.ui.defaultModelPlaceholder}
						aria-label="Custom default harvester model id"
					/>
				{/if}
				<span class="muted small">
					Seeds the model-backed harvester for newly created conversations. Pick a discovered model
					or enter an exact model id.
				</span>
			{:else}
				<input
					name="defaultMemoryExtractorModel"
					value={settings.defaultMemoryExtractorModel ?? ''}
					placeholder={selectedProviderStatus.ui.defaultModelPlaceholder}
				/>
				<span class="muted small">
					Seeds the model-backed harvester for newly created conversations.
				</span>
			{/if}
		</label>
		<label>
			Adversary review backend (experimental)
			<select name="defaultAdversaryBackend" bind:value={selectedAdversaryBackend}>
				<option value="">Same backend as the conversation</option>
				{#each adversaryBackendOptions as provider (provider.id)}
					<option value={provider.id}>{provider.displayName}</option>
				{/each}
			</select>
			<span class="muted small">
				Which backend serves the reviewer. Leaving this on the conversation's own backend is usually
				right: the reviewer needs to be a different <em>model</em> from the agent, which is unrelated
				to which endpoint serves it — and your chat backend already receives every tool call and its arguments,
				so reviewing them there adds no new destination.
			</span>
		</label>
		<label>
			Adversary review model (experimental)
			{#if adversaryProviderStatus && adversaryProviderStatus.models.length > 0}
				<input
					type="hidden"
					name="defaultAdversaryModel"
					value={selectedAdversaryModelFormValue()}
				/>
				<select bind:value={selectedAdversaryModelChoice}>
					<option value="">(off — no reviewer)</option>
					{#each adversaryProviderStatus.models as m (m.id)}
						<option value={m.id}>
							{m.name} — {m.id} ({formatContextWindow(m.maxContextWindowTokens)})
						</option>
					{/each}
					<option value={CUSTOM_MODEL_OPTION}>Enter a custom model id…</option>
				</select>
				{#if selectedAdversaryModelChoice === CUSTOM_MODEL_OPTION}
					<input
						bind:value={customAdversaryModel}
						placeholder={adversaryProviderStatus.ui.defaultModelPlaceholder}
						aria-label="Custom adversary review model id"
					/>
				{/if}
			{:else}
				<input
					name="defaultAdversaryModel"
					value={settings.defaultAdversaryModel ?? ''}
					placeholder="(off — leave blank)"
				/>
			{/if}
			<span class="muted small">
				Shadow-mode only: a second model reviews each permission request and records what it
				<em>would</em> have decided, next to what you actually clicked. It has no authority — it
				cannot allow, deny, or delay anything. Setting a model is what turns it on.
				<br />
				Pick a model in the review backend's namespace, and a different one from your agent's — a reviewer
				sharing the agent's weights shares its blind spots, so the shadow skips any conversation running
				the same model on the same backend.
				<br />
				Seeds newly created conversations only; existing ones keep their current setting. Sends tool arguments,
				which can include file contents, to the review backend.
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
		border-left-color: var(--warning);
	}
	.feature-note li[data-tone='bad'] {
		border-left-color: var(--danger);
	}
	.small {
		font-size: var(--fs-md);
	}
</style>
