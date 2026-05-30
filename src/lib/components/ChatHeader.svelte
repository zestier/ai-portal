<script lang="ts">
	import type {
		Conversation,
		ConversationUsage,
		ProviderRuntimeFeatureStatus,
		ProviderCapabilities,
		MemoryMode,
		SessionMode
	} from '$lib/types';
	import ContextMeter from './ContextMeter.svelte';

	let {
		title,
		conversation,
		providerCapabilities,
		providerDisplayName,
		model,
		providerModels,
		providerModelsError = null,
		defaultModelPlaceholder,
		parent = null,
		usage = null,
		recentCompaction = null,
		mode,
		memoryMode,
		memoryExtractorModel,
		globalMemoryEnabled,
		approveAllTools,
		modelChangeDisabled = false,
		onSettingsChange
	}: {
		title: string;
		conversation: Conversation;
		providerCapabilities: ProviderCapabilities;
		providerDisplayName: string;
		model: string;
		providerModels: { id: string; name: string; maxContextWindowTokens?: number }[];
		providerModelsError?: string | null;
		defaultModelPlaceholder: string;
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
		usage?: ConversationUsage | null;
		recentCompaction?: { tokensRemoved?: number; messagesRemoved?: number } | null;
		mode: SessionMode;
		memoryMode: MemoryMode;
		memoryExtractorModel: string | null;
		globalMemoryEnabled: boolean;
		approveAllTools: boolean;
		modelChangeDisabled?: boolean;
		// Fires with the optimistic patch right before the PATCH request,
		// so the parent can mirror state without waiting for the SSE echo.
		onSettingsChange?: (patch: {
			model?: string;
			mode?: SessionMode;
			memoryMode?: MemoryMode;
			memoryExtractorModel?: string | null;
			globalMemoryEnabled?: boolean;
			approveAllTools?: boolean;
		}) => void;
	} = $props();

	let expanded = $state(false);
	let savingModel = $state(false);
	let savingMode = $state(false);
	let savingMemory = $state(false);
	let savingHarvester = $state(false);
	let savingGlobalMemory = $state(false);
	let savingApprove = $state(false);
	let resetting = $state(false);
	let resetFlash = $state<'ok' | 'err' | null>(null);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;
	let selectedModelChoice = $state('');
	let customModel = $state('');
	let selectedHarvesterChoice = $state('');
	let customHarvesterModel = $state('');
	const CUSTOM_MODEL_OPTION = '__custom__';
	const DEFAULT_HARVESTER_OPTION = '__default__';

	const MODES: { value: SessionMode; label: string; hint: string }[] = [
		{
			value: 'interactive',
			label: 'Interactive',
			hint: 'Normal chat; tools prompt for permission.'
		},
		{
			value: 'plan',
			label: 'Plan',
			hint: 'Plan-only; destructive tools blocked until you exit plan mode.'
		},
		{
			value: 'autopilot',
			label: 'Autopilot',
			hint: 'Agent decides when to switch into less-supervised execution.'
		},
		{
			value: 'best-effort',
			label: 'Best effort',
			hint: 'Autopilot-style execution, but permission prompts auto-reject with feedback.'
		}
	];
	const MEMORY_MODES: { value: MemoryMode; label: string; hint: string }[] = [
		{ value: 'off', label: 'Off', hint: 'Use the provider context normally.' },
		{
			value: 'lightweight',
			label: 'Lightweight',
			hint: 'Fresh context with durable decisions, facts, preferences, and open loops.'
		},
		{
			value: 'project',
			label: 'Project',
			hint: 'Coding-aware memory; repository claims remain historical until rechecked.'
		},
		{
			value: 'story',
			label: 'Story',
			hint: 'Track characters, objects, locations, and plot state.'
		},
		{
			value: 'strict',
			label: 'Strict',
			hint: 'Aggressive recall and validation for timelines, secrets, clues, and tiny details.'
		}
	];

	const modeFeature = $derived(providerCapabilities.features.modes);
	const approveAllFeature = $derived(providerCapabilities.features.approveAll);
	const supportsRuntimeModes = $derived(
		modeFeature.supported && modeFeature.behavior === 'supported'
	);
	const showContextMeter = $derived(
		providerCapabilities.features.contextUsage.supported || usage !== null
	);
	const unavailableRuntimeFeatures = $derived.by(() =>
		Object.values(providerCapabilities.features).filter(
			(feature): feature is ProviderRuntimeFeatureStatus =>
				!feature.supported || feature.behavior === 'no-op'
		)
	);
	const currentModeLabel = $derived(MODES.find((opt) => opt.value === mode)?.label ?? mode);
	const selectedCustomModel = $derived(customModel.trim());
	const customModelUnchanged = $derived(selectedCustomModel === model);
	const customModelInvalid = $derived(selectedCustomModel.length === 0 || customModelUnchanged);
	const currentHarvesterModel = $derived(memoryExtractorModel ?? '');
	const selectedCustomHarvester = $derived(customHarvesterModel.trim());
	const customHarvesterUnchanged = $derived(selectedCustomHarvester === currentHarvesterModel);
	const customHarvesterInvalid = $derived(
		selectedCustomHarvester.length === 0 || customHarvesterUnchanged
	);

	$effect(() => {
		const modelIds = new Set(providerModels.map((providerModel) => providerModel.id));
		if (modelIds.has(model)) {
			selectedModelChoice = model;
			customModel = '';
		} else {
			selectedModelChoice = CUSTOM_MODEL_OPTION;
			customModel = model;
		}
		if (!memoryExtractorModel) {
			selectedHarvesterChoice = DEFAULT_HARVESTER_OPTION;
			customHarvesterModel = '';
		} else if (modelIds.has(memoryExtractorModel)) {
			selectedHarvesterChoice = memoryExtractorModel;
			customHarvesterModel = '';
		} else {
			selectedHarvesterChoice = CUSTOM_MODEL_OPTION;
			customHarvesterModel = memoryExtractorModel;
		}
	});

	function formatContextWindow(tokens: number | undefined): string {
		if (!tokens || !Number.isFinite(tokens)) return 'context size unknown';
		if (tokens >= 1_000_000) {
			const m = tokens / 1_000_000;
			const str = m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '');
			return `${str}M ctx`;
		}
		if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
		return `${tokens} ctx`;
	}

	async function patchSession(body: {
		model?: string;
		mode?: SessionMode;
		memoryMode?: MemoryMode;
		memoryExtractorModel?: string | null;
		globalMemoryEnabled?: boolean;
		approveAllTools?: boolean;
	}) {
		const res = await fetch(`/api/conversations/${conversation.id}/session`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`session patch failed: ${res.status}`);
	}

	async function chooseModel(next: string) {
		const trimmed = next.trim();
		if (!trimmed || trimmed === model || savingModel || modelChangeDisabled) return;
		savingModel = true;
		const prev = model;
		onSettingsChange?.({ model: trimmed });
		try {
			await patchSession({ model: trimmed });
		} catch {
			onSettingsChange?.({ model: prev });
		} finally {
			savingModel = false;
		}
	}

	function selectModel(e: Event) {
		const next = (e.currentTarget as HTMLSelectElement).value;
		selectedModelChoice = next;
		if (next !== CUSTOM_MODEL_OPTION) {
			void chooseModel(next);
		}
	}

	async function chooseMode(next: SessionMode) {
		if (next === mode || savingMode) return;
		savingMode = true;
		const prev = mode;
		onSettingsChange?.({ mode: next });
		try {
			await patchSession({ mode: next });
		} catch {
			onSettingsChange?.({ mode: prev });
		} finally {
			savingMode = false;
		}
	}

	async function chooseMemoryMode(next: MemoryMode) {
		if (next === memoryMode || savingMemory || modelChangeDisabled) return;
		savingMemory = true;
		const prev = memoryMode;
		onSettingsChange?.({ memoryMode: next });
		try {
			await patchSession({ memoryMode: next });
		} catch {
			onSettingsChange?.({ memoryMode: prev });
		} finally {
			savingMemory = false;
		}
	}

	async function chooseHarvesterModel(next: string | null) {
		const normalized = next?.trim() || null;
		if (normalized === memoryExtractorModel || savingHarvester || modelChangeDisabled) return;
		savingHarvester = true;
		const prev = memoryExtractorModel;
		onSettingsChange?.({ memoryExtractorModel: normalized });
		try {
			await patchSession({ memoryExtractorModel: normalized });
		} catch {
			onSettingsChange?.({ memoryExtractorModel: prev });
		} finally {
			savingHarvester = false;
		}
	}

	function selectHarvesterModel(e: Event) {
		const next = (e.currentTarget as HTMLSelectElement).value;
		selectedHarvesterChoice = next;
		if (next === DEFAULT_HARVESTER_OPTION) {
			void chooseHarvesterModel(null);
		} else if (next !== CUSTOM_MODEL_OPTION) {
			void chooseHarvesterModel(next);
		}
	}

	async function toggleGlobalMemory(e: Event) {
		const next = (e.currentTarget as HTMLInputElement).checked;
		if (savingGlobalMemory || modelChangeDisabled) return;
		savingGlobalMemory = true;
		const prev = globalMemoryEnabled;
		onSettingsChange?.({ globalMemoryEnabled: next });
		try {
			await patchSession({ globalMemoryEnabled: next });
		} catch {
			onSettingsChange?.({ globalMemoryEnabled: prev });
		} finally {
			savingGlobalMemory = false;
		}
	}

	async function toggleApproveAll(e: Event) {
		const next = (e.currentTarget as HTMLInputElement).checked;
		if (savingApprove) return;
		savingApprove = true;
		const prev = approveAllTools;
		onSettingsChange?.({ approveAllTools: next });
		try {
			await patchSession({ approveAllTools: next });
		} catch {
			onSettingsChange?.({ approveAllTools: prev });
		} finally {
			savingApprove = false;
		}
	}

	async function resetApprovals() {
		if (resetting) return;
		resetting = true;
		try {
			const res = await fetch(`/api/conversations/${conversation.id}/session`, {
				method: 'POST'
			});
			resetFlash = res.ok ? 'ok' : 'err';
		} catch {
			resetFlash = 'err';
		} finally {
			resetting = false;
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => (resetFlash = null), 2400);
		}
	}

	const miniPct = $derived.by(() => {
		if (!usage || usage.tokenLimit <= 0) return 0;
		return Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
	});
	const miniLevel = $derived.by<'low' | 'mid' | 'high'>(() => {
		if (miniPct >= 90) return 'high';
		if (miniPct >= 70) return 'mid';
		return 'low';
	});
</script>

<header class="chat-header" class:expanded>
	<button
		type="button"
		class="chat-header-row"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
		aria-controls="chat-header-details"
	>
		<span class="title-wrap"><h2>{title}</h2></span>
		{#if usage}
			<span
				class="mini-meter"
				data-level={miniLevel}
				aria-hidden="true"
				title={`${usage.currentTokens.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens`}
			>
				<span class="mini-fill" style="width: {miniPct}%"></span>
			</span>
		{/if}
		<svg
			class="chevron"
			width="12"
			height="12"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 6l4 4 4-4" />
		</svg>
	</button>
	<div class="chat-header-details" id="chat-header-details">
		<div class="details-inner">
			<div class="details-body">
				<dl class="header-meta">
					<dt>Provider</dt>
					<dd>{providerDisplayName}</dd>
					<dt>Model</dt>
					<dd>{model}</dd>
					<dt>Workdir</dt>
					<dd class="mono">{conversation.workdir}</dd>
					<dt>ID</dt>
					<dd class="mono">{conversation.id}</dd>
				</dl>
				{#if parent}
					<div class="parent-crumb">
						<svg
							width="11"
							height="11"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M6 3l-3 3 3 3" />
							<path d="M3 6h7a3 3 0 013 3v4" />
						</svg>
						<span>Forked from</span>
						<a href={`/conversations/${parent.id}`}>{parent.title}</a>
						{#if parent.messageIndex != null}
							<span>· at message {parent.messageIndex + 1}</span>
						{/if}
					</div>
				{/if}
				{#if showContextMeter}
					<ContextMeter {usage} {recentCompaction} />
				{/if}
				{#if unavailableRuntimeFeatures.length > 0}
					<div class="capability-notes" aria-label="Provider capability notes">
						<strong>Provider capability limits</strong>
						<ul>
							{#each unavailableRuntimeFeatures as feature (feature.label)}
								<li>
									<span>{feature.label}</span>
									<small>{feature.description}</small>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div class="session-settings" role="group" aria-label="Session settings">
					<div class="setting-row model-row">
						<span class="setting-label">Model</span>
						{#if providerModels.length > 0}
							<select
								class="model-select"
								aria-label="Session model"
								bind:value={selectedModelChoice}
								disabled={savingModel || modelChangeDisabled}
								onchange={selectModel}
							>
								{#each providerModels as providerModel (providerModel.id)}
									<option value={providerModel.id}>
										{providerModel.name} — {providerModel.id} ({formatContextWindow(
											providerModel.maxContextWindowTokens
										)})
									</option>
								{/each}
								<option value={CUSTOM_MODEL_OPTION}>Enter a custom model id…</option>
							</select>
						{:else}
							<input
								class="model-input"
								bind:value={customModel}
								placeholder={defaultModelPlaceholder}
								disabled={savingModel || modelChangeDisabled}
								aria-label="Custom session model id"
								onkeydown={(e) => {
									if (e.key === 'Enter' && !customModelInvalid)
										void chooseModel(selectedCustomModel);
								}}
							/>
						{/if}
						{#if selectedModelChoice === CUSTOM_MODEL_OPTION}
							<div class="model-custom">
								{#if providerModels.length > 0}
									<input
										class="model-input"
										bind:value={customModel}
										placeholder={defaultModelPlaceholder}
										disabled={savingModel || modelChangeDisabled}
										aria-label="Custom session model id"
										onkeydown={(e) => {
											if (e.key === 'Enter' && !customModelInvalid)
												void chooseModel(selectedCustomModel);
										}}
									/>
								{/if}
								<button
									type="button"
									class="save-model-btn"
									disabled={savingModel || modelChangeDisabled || customModelInvalid}
									onclick={() => chooseModel(selectedCustomModel)}
								>
									{savingModel ? 'Saving…' : 'Save model'}
								</button>
							</div>
						{/if}
						{#if modelChangeDisabled}
							<span class="unsupported-chip">model locked during turn</span>
						{:else if providerModelsError}
							<span class="unsupported-chip" title={providerModelsError}
								>model list unavailable</span
							>
						{/if}
					</div>
					<div class="setting-row">
						<span class="setting-label">Mode</span>
						{#if supportsRuntimeModes}
							<div class="seg" role="radiogroup" aria-label="Session mode" aria-busy={savingMode}>
								{#each MODES as opt (opt.value)}
									<button
										type="button"
										role="radio"
										aria-checked={mode === opt.value}
										class="seg-btn"
										class:active={mode === opt.value}
										title={opt.hint}
										disabled={savingMode}
										onclick={() => chooseMode(opt.value)}
									>
										{opt.label}
									</button>
								{/each}
							</div>
						{:else}
							<span class="unsupported-chip" title={modeFeature.description}>
								{currentModeLabel} · provider no-op
							</span>
						{/if}
					</div>
					<div class="setting-row">
						<span class="setting-label">Memory</span>
						<div
							class="seg memory-seg"
							role="radiogroup"
							aria-label="Memory mode"
							aria-busy={savingMemory}
						>
							{#each MEMORY_MODES as opt (opt.value)}
								<button
									type="button"
									role="radio"
									aria-checked={memoryMode === opt.value}
									class="seg-btn"
									class:active={memoryMode === opt.value}
									title={opt.hint}
									disabled={savingMemory || modelChangeDisabled}
									onclick={() => chooseMemoryMode(opt.value)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
						{#if modelChangeDisabled}
							<span class="unsupported-chip">memory locked during turn</span>
						{:else if memoryMode !== 'off'}
							<span
								class="unsupported-chip"
								title="Fresh-context turns include mandatory memory tools."
							>
								fresh context + tools
							</span>
						{/if}
					</div>
					{#if memoryMode !== 'off'}
						<div class="setting-row model-row">
							<span class="setting-label">Harvester</span>
							<select
								class="model-select"
								aria-label="Memory harvester model"
								bind:value={selectedHarvesterChoice}
								disabled={savingHarvester || modelChangeDisabled}
								onchange={selectHarvesterModel}
							>
								<option value={DEFAULT_HARVESTER_OPTION}>Server default harvester</option>
								{#each providerModels as providerModel (providerModel.id)}
									<option value={providerModel.id}>
										{providerModel.name} — {providerModel.id}
									</option>
								{/each}
								<option value={CUSTOM_MODEL_OPTION}>Enter a custom harvester model id…</option>
							</select>
							{#if selectedHarvesterChoice === CUSTOM_MODEL_OPTION}
								<div class="model-custom">
									<input
										class="model-input"
										bind:value={customHarvesterModel}
										placeholder="harvester-model-id"
										disabled={savingHarvester || modelChangeDisabled}
										aria-label="Custom memory harvester model id"
										onkeydown={(e) => {
											if (e.key === 'Enter' && !customHarvesterInvalid)
												void chooseHarvesterModel(selectedCustomHarvester);
										}}
									/>
									<button
										type="button"
										class="save-model-btn"
										disabled={savingHarvester || modelChangeDisabled || customHarvesterInvalid}
										onclick={() => chooseHarvesterModel(selectedCustomHarvester)}
									>
										{savingHarvester ? 'Saving…' : 'Save harvester'}
									</button>
								</div>
							{/if}
							<span
								class="unsupported-chip"
								title="Overrides the model-backed memory extractor when one is configured. Leave default to use server settings."
							>
								{memoryExtractorModel ?? 'server default'}
							</span>
						</div>
						<div class="setting-row">
							<label class="approve-toggle">
								<input
									type="checkbox"
									checked={globalMemoryEnabled}
									disabled={savingGlobalMemory || modelChangeDisabled}
									onchange={toggleGlobalMemory}
								/>
								<span>Enable cross-session global memory tools</span>
							</label>
							<span
								class="unsupported-chip"
								title="When enabled, this conversation may read and write explicit user-scoped global memories through memory_global_* tools."
							>
								{globalMemoryEnabled ? 'global memory on' : 'session-only'}
							</span>
						</div>
					{/if}
					<div class="setting-row">
						<label class="approve-toggle">
							<input
								type="checkbox"
								checked={approveAllTools}
								disabled={savingApprove || !approveAllFeature.supported}
								onchange={toggleApproveAll}
							/>
							<span>Approve all tool calls</span>
						</label>
						{#if providerCapabilities.controls.resetSessionApprovals}
							<button
								type="button"
								class="reset-btn"
								disabled={resetting}
								onclick={resetApprovals}
								title="Clear the runtime's session-scoped approvals."
							>
								{resetting ? 'Resetting…' : 'Reset session approvals'}
							</button>
						{:else}
							<span
								class="unsupported-chip"
								title="This provider has no session approval cache to clear."
							>
								approval reset unavailable
							</span>
						{/if}
						{#if resetFlash === 'ok'}
							<span class="reset-flash ok" aria-live="polite">Cleared</span>
						{:else if resetFlash === 'err'}
							<span class="reset-flash err" aria-live="polite">Failed</span>
						{/if}
					</div>
					{#if approveAllTools}
						<p class="approve-warning" role="note">
							{approveAllFeature.description} Audit entries still record each auto-approved portal tool
							as <code>auto-allow</code>.
						</p>
					{:else if mode === 'best-effort'}
						<p class="approve-warning" role="note">
							Permission prompts are auto-rejected in this conversation. The agent can keep trying
							alternatives, but it must stop once extra permission is truly required.
						</p>
					{/if}
				</div>
			</div>
		</div>
	</div>
</header>

<style>
	.chat-header {
		border-bottom: 1px solid var(--border);
	}
	.chat-header-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-5);
		background: transparent;
		border: 0;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font: inherit;
		transition: background 0.12s ease;
	}
	.chat-header-row:hover {
		background: var(--surface-2);
	}
	.chat-header-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.title-wrap {
		flex: 1;
		min-width: 0;
	}
	.title-wrap h2 {
		margin: 0;
		font-size: var(--fs-lg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mini-meter {
		flex: 0 0 auto;
		position: relative;
		width: 72px;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.mini-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--success);
		opacity: 0.6;
		transition: width 240ms ease-out;
	}
	.mini-meter[data-level='mid'] .mini-fill {
		background: var(--warning);
	}
	.mini-meter[data-level='high'] .mini-fill {
		background: var(--danger);
	}
	.chevron {
		flex: 0 0 auto;
		opacity: 0.6;
		transition: transform 160ms ease;
	}
	.chat-header.expanded .chevron {
		transform: rotate(180deg);
	}
	.chat-header-details {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 160ms ease;
	}
	.chat-header.expanded .chat-header-details {
		grid-template-rows: 1fr;
	}
	.details-inner {
		min-height: 0;
		overflow: hidden;
	}
	.details-body {
		padding: var(--space-1) var(--space-5) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		font-size: var(--fs-xs);
	}
	.header-meta {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: var(--space-3);
		row-gap: var(--space-1);
		margin: 0;
	}
	.header-meta dt {
		opacity: 0.6;
	}
	.header-meta dd {
		margin: 0;
		word-break: break-all;
	}
	.mono {
		font-family: var(--mono);
	}
	.parent-crumb {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.parent-crumb a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
	}
	.parent-crumb a:hover {
		text-decoration-color: currentColor;
	}
	.capability-notes {
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
	}
	.capability-notes strong {
		display: block;
		margin-bottom: var(--space-1);
	}
	.capability-notes ul {
		margin: 0;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.capability-notes li span {
		font-weight: 600;
	}
	.capability-notes li small {
		display: block;
		opacity: 0.75;
	}
	@media (prefers-reduced-motion: reduce) {
		.chat-header-details,
		.chevron,
		.mini-fill {
			transition: none;
		}
	}
	.session-settings {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--border);
	}
	.setting-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.setting-label {
		opacity: 0.6;
		min-width: 3.5rem;
	}
	.model-row {
		align-items: flex-start;
	}
	.model-select,
	.model-input {
		min-width: min(26rem, 100%);
		max-width: 100%;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: inherit;
		font: inherit;
		font-size: var(--fs-xs);
		padding: 2px 8px;
	}
	.model-custom {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-2);
	}
	.seg-btn {
		background: transparent;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 2px 10px;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.seg-btn + .seg-btn {
		border-left: 1px solid var(--border);
	}
	.seg-btn:hover:not(:disabled) {
		background: var(--surface-3, var(--surface-2));
	}
	.seg-btn.active {
		background: var(--accent);
		color: var(--accent-fg, white);
	}
	.seg-btn:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.approve-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		cursor: pointer;
	}
	.approve-toggle input[type='checkbox'] {
		margin: 0;
	}
	.reset-btn {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: inherit;
		font: inherit;
		font-size: var(--fs-xs);
		padding: 2px 8px;
		border-radius: 4px;
		cursor: pointer;
	}
	.reset-btn:hover:not(:disabled) {
		background: var(--surface-3, var(--surface-2));
	}
	.save-model-btn {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: inherit;
		font: inherit;
		font-size: var(--fs-xs);
		padding: 2px 8px;
		border-radius: 4px;
		cursor: pointer;
	}
	.save-model-btn:hover:not(:disabled) {
		background: var(--surface-3, var(--surface-2));
	}
	.model-select:disabled,
	.model-input:disabled,
	.save-model-btn:disabled,
	.reset-btn:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.reset-flash {
		font-size: var(--fs-xs);
	}
	.reset-flash.ok {
		color: var(--success);
	}
	.reset-flash.err {
		color: var(--danger);
	}
	.unsupported-chip {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		padding: 2px 8px;
		opacity: 0.78;
	}
	.approve-warning {
		margin: 0;
		padding: var(--space-1) var(--space-2);
		background: color-mix(in srgb, var(--warning) 14%, transparent);
		border-left: 2px solid var(--warning);
		border-radius: 3px;
		font-size: var(--fs-xs);
	}
	.approve-warning code {
		font-family: var(--mono);
		font-size: 0.95em;
	}
</style>
