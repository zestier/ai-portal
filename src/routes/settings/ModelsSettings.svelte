<script lang="ts">
	import { onMount } from 'svelte';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import type { ManagedModel, ManagedProvider, ModelCost, ProviderApi } from '$lib/types';

	const PROVIDER_APIS: { value: ProviderApi; label: string }[] = [
		{ value: 'anthropic-messages', label: 'Anthropic Messages' },
		{ value: 'openai-completions', label: 'OpenAI Completions' },
		{ value: 'openai-responses', label: 'OpenAI Responses' },
		{ value: 'google-generative-ai', label: 'Google Generative AI' }
	];

	let providers = $state<ManagedProvider[]>([]);
	let models = $state<ManagedModel[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notice = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

	// --- provider form ---
	let showProviderForm = $state(false);
	let pId = $state('');
	let pName = $state('');
	let pApi = $state<ProviderApi>('openai-completions');
	let pBaseUrl = $state('');
	let pBuiltin = $state(false);
	let pHeaders = $state('');
	let pEnabled = $state(true);
	let savingProvider = $state(false);

	// --- key drafts (per provider) ---
	let keyDrafts = $state<Record<string, string>>({});
	let savingKey = $state<Record<string, boolean>>({});

	// --- model form (per provider) ---
	let modelFormFor = $state<string | null>(null);
	let mId = $state('');
	let mName = $state('');
	let mPurpose = $state('');
	let mCostInput = $state('');
	let mContextWindow = $state('');
	let mMaxTokens = $state('');
	let mReasoning = $state(false);
	let mEnabled = $state(true);
	let savingModel = $state(false);

	let fetching = $state<Record<string, boolean>>({});
	let importingPi = $state<Record<string, boolean>>({});

	const modelsFor = (providerId: string): ManagedModel[] =>
		models.filter((m) => m.providerId === providerId);

	function flash(kind: 'ok' | 'err', text: string) {
		notice = { kind, text };
		setTimeout(() => {
			if (notice?.text === text) notice = null;
		}, 5000);
	}

	async function api<T>(path: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
		const res = await fetch(path, {
			headers: { 'content-type': 'application/json' },
			...init
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
		}
		return res.json() as Promise<T>;
	}

	async function reload() {
		try {
			loadError = null;
			const data = await api<{ providers: ManagedProvider[]; models: ManagedModel[] }>(
				'/api/admin/models'
			);
			providers = data.providers;
			models = data.models;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void reload();
	});

	// --- provider actions ---

	function resetProviderForm() {
		pId = '';
		pName = '';
		pApi = 'openai-completions';
		pBaseUrl = '';
		pBuiltin = false;
		pHeaders = '';
		pEnabled = true;
		showProviderForm = false;
	}

	async function saveProvider() {
		if (savingProvider) return;
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(pId)) {
			flash('err', 'Provider id must be lowercase letters, digits, "-" or "_".');
			return;
		}
		if (!pBuiltin && !pBaseUrl.trim()) {
			flash('err', 'Custom providers need a base URL (e.g. http://localhost:11434/v1).');
			return;
		}
		savingProvider = true;
		try {
			await api('/api/admin/models', {
				method: 'POST',
				body: JSON.stringify({
					action: 'provider',
					id: pId,
					name: pName || pId,
					api: pApi,
					baseUrl: pBaseUrl.trim() || undefined,
					headers: parseHeaders(pHeaders),
					authHeader: false,
					builtin: pBuiltin,
					enabled: pEnabled
				})
			});
			flash('ok', `Provider "${pId}" saved.`);
			resetProviderForm();
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			savingProvider = false;
		}
	}

	function parseHeaders(raw: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const idx = line.indexOf(':');
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (key) out[key] = value;
		}
		return out;
	}

	async function removeProvider(id: string) {
		if (!confirm(`Delete provider "${id}" and all its models?`)) return;
		try {
			await api(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
			flash('ok', `Provider "${id}" deleted.`);
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		}
	}

	async function saveKey(id: string) {
		const key = keyDrafts[id] ?? '';
		if (!key.trim()) {
			if (!confirm(`Remove the stored API key for "${id}"?`)) return;
		}
		savingKey = { ...savingKey, [id]: true };
		try {
			await api(`/api/admin/models/${encodeURIComponent(id)}`, {
				method: 'POST',
				body: JSON.stringify({ apiKey: key.trim() })
			});
			keyDrafts = { ...keyDrafts, [id]: '' };
			flash('ok', key.trim() ? `API key saved for "${id}".` : `API key removed for "${id}".`);
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			savingKey = { ...savingKey, [id]: false };
		}
	}

	async function fetchCatalog(id: string) {
		fetching = { ...fetching, [id]: true };
		try {
			const r = await api<{ imported: number }>(
				`/api/admin/models/${encodeURIComponent(id)}/fetch`,
				{ method: 'POST' }
			);
			flash('ok', `Fetched from "${id}": ${r.imported} model(s) imported.`);
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			fetching = { ...fetching, [id]: false };
		}
	}

	async function importPiCatalog(id: string) {
		importingPi = { ...importingPi, [id]: true };
		try {
			const r = await api<{ imported: number }>(
				`/api/admin/models/${encodeURIComponent(id)}/pi-catalog`,
				{ method: 'POST' }
			);
			flash('ok', `Imported ${r.imported} model(s) from pi's bundled catalog.`);
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			importingPi = { ...importingPi, [id]: false };
		}
	}

	// --- model actions ---

	function resetModelForm() {
		mId = '';
		mName = '';
		mPurpose = '';
		mCostInput = '';
		mContextWindow = '';
		mMaxTokens = '';
		mReasoning = false;
		mEnabled = true;
		modelFormFor = null;
	}

	function parseCost(raw: string): Partial<ModelCost> | undefined {
		if (!raw.trim()) return undefined;
		const parts: Record<string, number> = {};
		for (const pair of raw.split(/[,\s]+/)) {
			const [k, v] = pair.split(/[=:]/);
			if (!k || !v) continue;
			const num = Number(v);
			if (Number.isFinite(num)) parts[k] = num;
		}
		return parts.input !== undefined || parts.output !== undefined || parts.cacheRead !== undefined
			? {
					input: parts.input ?? 0,
					output: parts.output ?? 0,
					cacheRead: parts.cacheRead ?? 0,
					cacheWrite: parts.cacheWrite ?? 0
				}
			: undefined;
	}

	function parsePositiveInt(raw: string): number | null {
		const n = Number(raw);
		return raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
	}

	async function saveModel(providerId: string) {
		if (savingModel) return;
		if (!mId.trim()) {
			flash('err', 'Model id is required.');
			return;
		}
		savingModel = true;
		try {
			await api('/api/admin/models', {
				method: 'POST',
				body: JSON.stringify({
					action: 'model',
					providerId,
					id: mId.trim(),
					name: mName.trim() || mId.trim(),
					purpose: mPurpose.trim() || null,
					enabled: mEnabled,
					cost: parseCost(mCostInput),
					contextWindow: parsePositiveInt(mContextWindow),
					maxTokens: parsePositiveInt(mMaxTokens),
					reasoning: mReasoning
				})
			});
			flash('ok', `Model "${mId}" saved.`);
			resetModelForm();
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			savingModel = false;
		}
	}

	async function toggleModel(m: ManagedModel) {
		try {
			await api('/api/admin/models', {
				method: 'POST',
				body: JSON.stringify({
					action: 'model',
					providerId: m.providerId,
					id: m.id,
					name: m.name,
					purpose: m.purpose,
					enabled: !m.enabled,
					cost: m.cost,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					input: m.input
				})
			});
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		}
	}

	async function removeModel(providerId: string, id: string) {
		if (!confirm(`Delete model "${id}"?`)) return;
		try {
			await api('/api/admin/models', {
				method: 'POST',
				body: JSON.stringify({ action: 'delete-model', providerId, id })
			});
			flash('ok', `Model "${id}" deleted.`);
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		}
	}

	function formatCost(c: ModelCost): string {
		const rates = [c.input, c.output, c.cacheRead, c.cacheWrite];
		if (rates.every((r) => r === 0)) return '—';
		return `$${c.input}/${c.output}/${c.cacheRead}/${c.cacheWrite} (in/out/cacheR/cacheW per 1M)`;
	}
</script>

<div
	id="settings-panel-models"
	class="tab-panel models"
	role="tabpanel"
	aria-labelledby="settings-tab-models"
>
	<PanelHeader title="Models" fullBleed>
		{#snippet meta()}
			Configure providers and models the portal serves. Keys are encrypted at rest; the catalog is
			written to <code>DATA_DIR/models.json</code> and reloaded live.
		{/snippet}
	</PanelHeader>

	{#if notice}
		<div class="notice" class:ok={notice.kind === 'ok'} class:err={notice.kind === 'err'}>
			{notice.text}
		</div>
	{/if}

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if loadError}
		<p class="error-text">{loadError}</p>
	{:else}
		<div class="models-body">
			{#if providers.length === 0}
				<p class="muted">
					No providers configured yet. Add one to start serving models — pick a bundled provider
					(Anthropic, OpenAI, …) to use pi's built-in catalog, or a custom OpenAI-compatible
					endpoint (Ollama, vLLM, LM Studio, gateways).
				</p>
			{/if}

			{#each providers as p (p.id)}
				<section class="provider-card">
					<header class="provider-head">
						<div>
							<strong>{p.name}</strong>
							<span class="muted small">{p.id} · {p.api}{p.builtin ? ' · built-in' : ''}</span>
						</div>
						<div class="head-actions">
							<label class="toggle">
								<input
									type="checkbox"
									checked={p.enabled}
									onchange={() => {
										void (async () => {
											try {
												await api('/api/admin/models', {
													method: 'POST',
													body: JSON.stringify({
														action: 'provider',
														id: p.id,
														name: p.name,
														api: p.api,
														baseUrl: p.baseUrl ?? undefined,
														headers: p.headers,
														authHeader: p.authHeader,
														builtin: p.builtin,
														enabled: !p.enabled
													})
												});
												await reload();
											} catch (e) {
												flash('err', e instanceof Error ? e.message : String(e));
											}
										})();
									}}
								/>
								enabled
							</label>
							<button type="button" class="danger" onclick={() => removeProvider(p.id)}
								>Delete</button
							>
						</div>
					</header>

					{#if p.baseUrl}
						<p class="muted small">baseUrl: <code>{p.baseUrl}</code></p>
					{/if}

					<div class="key-row">
						<span class="muted small">
							API key: {p.hasKey ? 'stored (encrypted)' : 'not set'}
						</span>
						<input
							type="password"
							placeholder={p.hasKey ? 'Replace key…' : 'Paste key…'}
							value={keyDrafts[p.id] ?? ''}
							oninput={(e) => (keyDrafts = { ...keyDrafts, [p.id]: e.currentTarget.value })}
						/>
						<button
							type="button"
							disabled={savingKey[p.id] || (keyDrafts[p.id] ?? '') === ''}
							onclick={() => saveKey(p.id)}
						>
							{savingKey[p.id] ? 'Saving…' : p.hasKey ? 'Save' : 'Set key'}
						</button>
						{#if p.hasKey}
							<button type="button" class="danger" onclick={() => saveKey(p.id)}>Remove</button>
						{/if}
					</div>

					<div class="provider-actions">
						<button
							type="button"
							disabled={!p.hasKey || fetching[p.id]}
							title={p.hasKey ? undefined : 'Save an API key first to fetch the catalog.'}
							onclick={() => fetchCatalog(p.id)}
						>
							{fetching[p.id] ? 'Fetching…' : 'Fetch catalog from provider'}
						</button>
						{#if p.builtin}
							<button
								type="button"
								disabled={importingPi[p.id]}
								onclick={() => importPiCatalog(p.id)}
							>
								{importingPi[p.id] ? 'Importing…' : 'Import from pi catalog'}
							</button>
						{/if}
					</div>

					<div class="models-list">
						{#each modelsFor(p.id) as m (m.id)}
							<div class="model-row">
								<label class="toggle">
									<input type="checkbox" checked={m.enabled} onchange={() => toggleModel(m)} />
									<span>
										<strong>{m.name}</strong>
										<span class="muted small">
											{m.id}{m.purpose ? ` · ${m.purpose}` : ''}
											{m.contextWindow ? ` · ${m.contextWindow.toLocaleString()} ctx` : ''}
											{m.reasoning ? ' · reasoning' : ''}
										</span>
										<span class="muted small cost">{formatCost(m.cost)}</span>
									</span>
								</label>
								<button type="button" class="danger" onclick={() => removeModel(p.id, m.id)}>
									Remove
								</button>
							</div>
						{/each}
						{#if modelsFor(p.id).length === 0}
							<p class="muted small">
								No models yet — add one, fetch the provider catalog, or
								{#if p.builtin}import from pi's catalog{/if}.
							</p>
						{/if}
					</div>

					{#if modelFormFor === p.id}
						<div class="model-form">
							<div class="grid">
								<label>Model id <input bind:value={mId} placeholder="claude-sonnet-4-5" /></label>
								<label>Name <input bind:value={mName} placeholder="Claude Sonnet 4.5" /></label>
								<label
									>Purpose <input
										bind:value={mPurpose}
										placeholder="daily driver, cheap, vision…"
									/></label
								>
								<label>
									Cost
									<input
										bind:value={mCostInput}
										placeholder="input=3, output=15, cacheRead=0.3, cacheWrite=3.75"
									/>
								</label>
								<label>
									Context window
									<input bind:value={mContextWindow} type="number" min="1" placeholder="200000" />
								</label>
								<label>
									Max output tokens
									<input bind:value={mMaxTokens} type="number" min="1" placeholder="64000" />
								</label>
							</div>
							<div class="checks">
								<label><input type="checkbox" bind:checked={mReasoning} /> reasoning</label>
								<label><input type="checkbox" bind:checked={mEnabled} /> enabled</label>
							</div>
							<div class="form-actions">
								<button type="button" disabled={savingModel} onclick={() => saveModel(p.id)}>
									{savingModel ? 'Saving…' : 'Save model'}
								</button>
								<button type="button" onclick={resetModelForm}>Cancel</button>
							</div>
						</div>
					{:else}
						<button type="button" class="add" onclick={() => (modelFormFor = p.id)}
							>+ Add model</button
						>
					{/if}
				</section>
			{/each}

			{#if showProviderForm}
				<section class="provider-card new">
					<h3>Add provider</h3>
					<div class="grid">
						<label>
							Provider id
							<input bind:value={pId} placeholder="anthropic, ollama, my-gateway…" />
						</label>
						<label>Name <input bind:value={pName} placeholder="Anthropic" /></label>
						<label>
							API
							<select value={pApi} onchange={(e) => (pApi = e.currentTarget.value as ProviderApi)}>
								{#each PROVIDER_APIS as api (api.value)}
									<option value={api.value}>{api.label}</option>
								{/each}
							</select>
						</label>
						<label>
							Base URL (required for custom providers)
							<input bind:value={pBaseUrl} placeholder="https://api.anthropic.com" />
						</label>
						<label class="span-2">
							Custom headers (one per line, "Name: value")
							<textarea bind:value={pHeaders} rows="2" placeholder="x-portkey-api-key: …"
							></textarea>
						</label>
					</div>
					<div class="checks">
						<label
							><input type="checkbox" bind:checked={pBuiltin} /> built-in provider (pi's bundled catalog)</label
						>
						<label><input type="checkbox" bind:checked={pEnabled} /> enabled</label>
					</div>
					<div class="form-actions">
						<button type="button" disabled={savingProvider} onclick={saveProvider}>
							{savingProvider ? 'Saving…' : 'Save provider'}
						</button>
						<button type="button" onclick={resetProviderForm}>Cancel</button>
					</div>
				</section>
			{:else}
				<button type="button" class="add" onclick={() => (showProviderForm = true)}>
					+ Add provider
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.models-body {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1rem;
	}
	.provider-card {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.9rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.provider-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.key-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.key-row input {
		flex: 1;
		min-width: 12rem;
	}
	.provider-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.models-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
	}
	.model-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}
	.model-row .toggle {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.model-row .toggle span {
		display: flex;
		flex-direction: column;
	}
	.cost {
		font-variant-numeric: tabular-nums;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.span-2 {
		grid-column: span 2;
	}
	.checks {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.form-actions {
		display: flex;
		gap: 0.5rem;
	}
	.notice {
		margin: 0.75rem 1rem 0;
		padding: 0.5rem 0.75rem;
		border-radius: 0.375rem;
		font-size: var(--fs-sm);
	}
	.notice.ok {
		background: var(--bg-ok, rgba(34, 197, 94, 0.12));
		color: var(--ok, #16a34a);
	}
	.notice.err,
	.error-text {
		color: var(--err, #dc2626);
	}
	.error-text {
		padding: 0 1rem;
	}
	button.danger {
		color: var(--err, #dc2626);
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.span-2 {
			grid-column: span 1;
		}
	}
</style>
