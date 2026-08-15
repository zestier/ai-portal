<script lang="ts">
	import { onMount } from 'svelte';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';
	import type { PortalExtension, PortalExtensionKind } from '$lib/types';

	const KINDS: { value: PortalExtensionKind; label: string }[] = [
		{ value: 'file', label: 'File' },
		{ value: 'inline', label: 'Inline' },
		{ value: 'package', label: 'Package' }
	];

	interface VerifyResult {
		loaded: string[];
		errors: { path: string; error: string }[];
	}

	let extensions = $state<PortalExtension[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notice = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

	// --- add/edit form ---
	let showForm = $state(false);
	let editingId = $state<string | null>(null);
	let formName = $state('');
	let formKind = $state<PortalExtensionKind>('inline');
	let formValue = $state('');
	let formEnabled = $state(true);
	let formSortOrder = $state(0);
	let saving = $state(false);
	let verifyAll = $state(false);
	let verifyingId = $state<string | null>(null);

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
			const data = await api<{ extensions: PortalExtension[] }>('/api/admin/extensions');
			extensions = data.extensions;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void reload();
	});

	function resetForm() {
		editingId = null;
		formName = '';
		formKind = 'inline';
		formValue = '';
		formEnabled = true;
		formSortOrder = 0;
		showForm = false;
	}

	function openNew() {
		resetForm();
		// Default sort order: one past the last entry.
		if (extensions.length > 0) {
			formSortOrder = Math.max(...extensions.map((e) => e.sortOrder)) + 1;
		}
		showForm = true;
	}

	function openEdit(e: PortalExtension) {
		editingId = e.id;
		formName = e.name;
		formKind = e.kind;
		formValue = e.value;
		formEnabled = e.enabled;
		formSortOrder = e.sortOrder;
		showForm = true;
	}

	function valuePreview(e: PortalExtension): string {
		if (e.kind === 'inline') {
			const oneLine = e.value.split('\n').join(' ').trim();
			return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
		}
		return e.value;
	}

	async function save() {
		if (saving) return;
		const name = formName.trim();
		if (!name) {
			flash('err', 'Name is required.');
			return;
		}
		const value = formValue.trim();
		if (!value) {
			flash('err', 'Value is required.');
			return;
		}
		if (formKind === 'package' && !/^(npm|git):[^\s]+@[^\s]+$/.test(value)) {
			flash(
				'err',
				'Package specs require an explicit version/ref, e.g. npm:scope/pkg@1.2.3 or git:github.com/user/repo@v1'
			);
			return;
		}
		saving = true;
		try {
			const body = {
				name,
				kind: formKind,
				value,
				enabled: formEnabled,
				sortOrder: formSortOrder,
				...(editingId !== null ? { action: 'update', id: editingId } : { action: 'create' })
			};
			await api('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify(body)
			});
			flash(
				'ok',
				editingId !== null ? `Extension "${name}" updated.` : `Extension "${name}" added.`
			);
			resetForm();
			await reload();
		} catch (e) {
			flash('err', e instanceof Error ? e.message : String(e));
		} finally {
			saving = false;
		}
	}

	async function toggle(e: PortalExtension) {
		try {
			await api('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify({ action: 'toggle', id: e.id, enabled: !e.enabled })
			});
			await reload();
		} catch (err) {
			flash('err', err instanceof Error ? err.message : String(err));
		}
	}

	async function setSortOrder(e: PortalExtension, raw: string) {
		const n = Number(raw);
		if (!Number.isFinite(n) || n === e.sortOrder) return;
		try {
			await api('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify({ action: 'update', id: e.id, sortOrder: Math.trunc(n) })
			});
			await reload();
		} catch (err) {
			flash('err', err instanceof Error ? err.message : String(err));
		}
	}

	async function remove(e: PortalExtension) {
		if (!confirm(`Delete extension "${e.name}"?`)) return;
		try {
			await api('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify({ action: 'delete', id: e.id })
			});
			flash('ok', `Extension "${e.name}" deleted.`);
			await reload();
		} catch (err) {
			flash('err', err instanceof Error ? err.message : String(err));
		}
	}

	async function verifyOne(e: PortalExtension) {
		if (verifyingId) return;
		verifyingId = e.id;
		try {
			const res = await api<VerifyResult>('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify({ action: 'verify', id: e.id })
			});
			surfaceVerify(res, e.name);
		} catch (err) {
			flash('err', err instanceof Error ? err.message : String(err));
		} finally {
			verifyingId = null;
		}
	}

	async function verifyAllEntries() {
		if (verifyAll) return;
		verifyAll = true;
		try {
			const res = await api<VerifyResult>('/api/admin/extensions', {
				method: 'POST',
				body: JSON.stringify({ action: 'verify' })
			});
			surfaceVerify(res, 'All extensions');
		} catch (err) {
			flash('err', err instanceof Error ? err.message : String(err));
		} finally {
			verifyAll = false;
		}
	}

	function surfaceVerify(res: VerifyResult, label: string) {
		const loaded = res.loaded.length;
		const failed = res.errors.length;
		const detail =
			failed > 0
				? res.errors
						.map((e) => `${e.path}: ${e.error}`)
						.join(' | ')
						.slice(0, 400)
				: undefined;
		if (failed === 0) {
			flash('ok', `${label}: ${loaded} extension(s) loaded.`);
		} else {
			flash('err', `${label}: ${loaded} loaded, ${failed} error(s)${detail ? ` — ${detail}` : ''}`);
		}
	}
</script>

<section class="extensions-card">
	<PanelHeader title="Extensions" fullBleed>
		{#snippet meta()}
			Run pi extensions across every conversation.
		{/snippet}
	</PanelHeader>

	<div class="warning">
		<strong>Extensions run with full system permissions and execute arbitrary code.</strong>
		Only add code you trust. Package sources install remote code via npm/git on the first open after a
		change (into the pi agent dir's temp folder). In multi-user mode this panel is admin-only.
	</div>

	<p class="muted small note">
		Changes apply to every conversation on its next turn (open sessions are recreated
		automatically). No auto-discovery — only the sources listed here load.
	</p>

	{#if notice}
		<div class="notice {notice.kind}">{notice.text}</div>
	{/if}
	{#if loadError}
		<div class="notice err">{loadError}</div>
	{/if}

	{#if loading}
		<p class="muted">Loading extensions…</p>
	{:else}
		<div class="ext-list">
			{#each extensions as e (e.id)}
				<div class="ext-row">
					<div class="ext-main">
						<div class="ext-title">
							<strong>{e.name}</strong>
							<span class="badge">{e.kind}</span>
							{#if !e.enabled}<span class="badge off">disabled</span>{/if}
						</div>
						<code class="preview">{valuePreview(e)}</code>
					</div>
					<div class="ext-actions">
						<label class="toggle" title="Load this extension on the next turn">
							<input type="checkbox" checked={e.enabled} onchange={() => toggle(e)} />
							enabled
						</label>
						<label class="sort" title="Load order (ascending)">
							order
							<input
								type="number"
								value={e.sortOrder}
								onchange={(ev) => setSortOrder(e, ev.currentTarget.value)}
							/>
						</label>
						<button type="button" disabled={verifyingId !== null} onclick={() => verifyOne(e)}>
							{verifyingId === e.id ? 'Verifying…' : 'Verify'}
						</button>
						<button type="button" onclick={() => openEdit(e)}>Edit</button>
						<button type="button" class="danger" onclick={() => remove(e)}>Delete</button>
					</div>
				</div>
			{:else}
				<p class="muted small">No extensions configured — everything behaves exactly as today.</p>
			{/each}
		</div>

		<div class="form-actions">
			{#if extensions.length > 0}
				<button type="button" disabled={verifyAll} onclick={verifyAllEntries}>
					{verifyAll ? 'Verifying…' : 'Verify all'}
				</button>
			{/if}
			{#if showForm}
				<button type="button" disabled={saving} onclick={save}>
					{saving ? 'Saving…' : editingId !== null ? 'Save changes' : 'Add extension'}
				</button>
				<button type="button" onclick={resetForm}>Cancel</button>
			{:else}
				<button type="button" class="add" onclick={openNew}>+ Add extension</button>
			{/if}
		</div>

		{#if showForm}
			<section class="ext-form">
				<h3>{editingId !== null ? 'Edit extension' : 'Add extension'}</h3>
				<div class="grid">
					<label>Name <input bind:value={formName} placeholder="My helper tools" /></label>
					<label>
						Kind
						<select
							value={formKind}
							onchange={(e) => (formKind = e.currentTarget.value as PortalExtensionKind)}
						>
							{#each KINDS as k (k.value)}
								<option value={k.value}>{k.label}</option>
							{/each}
						</select>
					</label>
					<label class="span-2">
						{#if formKind === 'file'}
							Path to a <code>.ts</code> file or directory (<code>index.ts</code>), relative to the
							project root (absolute paths pass through)
						{:else if formKind === 'inline'}
							TypeScript source (a default-exported extension factory)
						{:else}
							Package spec
						{/if}
						{#if formKind === 'package'}
							<input
								bind:value={formValue}
								placeholder="npm:scope/pkg@1.2.3 or git:github.com/user/repo@v1"
							/>
							<span class="muted small"
								>Pin an explicit @version/@ref — unpinned git refs re-pull on every session.</span
							>
						{:else if formKind === 'file'}
							<input bind:value={formValue} placeholder="extensions/my-extension.ts" />
						{:else}
							<textarea
								bind:value={formValue}
								rows="8"
								spellcheck="false"
								placeholder="export default (pi) => pi.on('session_start', handler)"
							></textarea>
						{/if}
					</label>
					<label>
						Sort order
						<input type="number" bind:value={formSortOrder} />
					</label>
					<label class="checks">
						<input type="checkbox" bind:checked={formEnabled} /> enabled
					</label>
				</div>
			</section>
		{/if}
	{/if}
</section>

<style>
	.extensions-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.warning {
		border: 1px solid var(--err, #dc2626);
		border-radius: 0.5rem;
		padding: 0.6rem 0.8rem;
		font-size: var(--fs-sm);
		background: rgba(220, 38, 38, 0.06);
	}
	.note {
		opacity: 0.85;
	}
	.notice {
		padding: 0.5rem 0.75rem;
		border-radius: 0.375rem;
		font-size: var(--fs-sm);
	}
	.notice.ok {
		background: var(--bg-ok, rgba(34, 197, 94, 0.12));
		color: var(--ok, #16a34a);
	}
	.notice.err {
		background: var(--bg-err, rgba(220, 38, 38, 0.12));
		color: var(--err, #dc2626);
	}
	.ext-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.ext-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		flex-wrap: wrap;
	}
	.ext-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
	}
	.ext-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.badge {
		font-size: var(--fs-xs, 0.7rem);
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		background: var(--accent, #4f8cff);
		color: #fff;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.badge.off {
		background: var(--text-muted, #888);
	}
	.preview {
		font-size: var(--fs-sm);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ext-actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.ext-actions .toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: var(--fs-sm);
	}
	.sort {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: var(--fs-sm);
		color: var(--text-muted);
	}
	.sort input {
		width: 4.5rem;
	}
	.form-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.ext-form {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.9rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.ext-form h3 {
		margin: 0;
		font-size: var(--fs-lg);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.grid label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--fs-sm);
	}
	.span-2 {
		grid-column: span 2;
	}
	.checks {
		flex-direction: row !important;
		align-items: center;
	}
	textarea {
		font-family: var(--mono, monospace);
		font-size: var(--fs-sm);
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
