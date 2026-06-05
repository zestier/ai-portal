<script lang="ts">
	import { untrack } from 'svelte';
	import type { FsEntry, TreeResponse } from '$lib/client/file-browser';
	import { STATUS_LABEL, STATUS_COLOR } from '$lib/client/file-browser';
	import DiffStat from './DiffStat.svelte';

	let {
		conversationId,
		selectedPath = null,
		showIgnored = $bindable(false),
		showHidden = $bindable(false),
		onselect,
		onrefresh
	}: {
		conversationId: string;
		selectedPath?: string | null;
		showIgnored?: boolean;
		showHidden?: boolean;
		onselect?: (entry: FsEntry) => void;
		onrefresh?: () => void;
	} = $props();

	interface Loaded {
		entries: FsEntry[];
		loading: boolean;
		error: string | null;
		expanded: boolean;
	}

	// Map of dir relPath ("" for root) -> loaded state.
	let dirs = $state<Record<string, Loaded>>({});
	let filter = $state('');
	let refreshToken = $state(0);

	async function loadDir(path: string) {
		const key = path;
		dirs[key] = dirs[key] ?? { entries: [], loading: false, error: null, expanded: true };
		dirs[key].loading = true;
		dirs[key].error = null;
		try {
			const params = new URLSearchParams();
			if (path) params.set('path', path);
			if (showHidden) params.set('hidden', '1');
			if (showIgnored) params.set('ignored', '1');
			const res = await fetch(`/api/conversations/${conversationId}/fs/tree?${params.toString()}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data: TreeResponse = await res.json();
			dirs[key] = {
				entries: data.entries,
				loading: false,
				error: null,
				expanded: dirs[key]?.expanded ?? true
			};
		} catch (e) {
			dirs[key] = {
				...(dirs[key] ?? { entries: [], expanded: true }),
				loading: false,
				error: e instanceof Error ? e.message : String(e)
			};
		}
	}

	$effect(() => {
		// Reload root when conversation or toggles change.
		void conversationId;
		void showHidden;
		void showIgnored;
		void refreshToken;
		untrack(() => {
			dirs = {};
			loadDir('');
		});
	});

	export function refresh() {
		refreshToken++;
		onrefresh?.();
	}

	async function toggleDir(entry: FsEntry) {
		const key = entry.relPath;
		const existing = dirs[key];
		if (existing) {
			dirs[key] = { ...existing, expanded: !existing.expanded };
			if (dirs[key].expanded && existing.entries.length === 0) {
				await loadDir(key);
			}
		} else {
			dirs[key] = { entries: [], loading: true, error: null, expanded: true };
			await loadDir(key);
		}
	}

	function pickFile(entry: FsEntry) {
		onselect?.(entry);
	}

	function matchesFilter(name: string): boolean {
		if (!filter) return true;
		return name.toLowerCase().includes(filter.toLowerCase());
	}

	function statusBadge(s: FsEntry['status'] | FsEntry['containsChanges']) {
		if (!s) return null;
		return { label: STATUS_LABEL[s], color: STATUS_COLOR[s] };
	}

	const rootLoading = $derived(!!dirs['']?.loading);
</script>

<div class="tree-root">
	<div class="panel-toolbar">
		<div class="search-wrap">
			<svg
				class="search-icon"
				width="14"
				height="14"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="7" cy="7" r="4.5" />
				<path d="M10.5 10.5L14 14" />
			</svg>
			<input
				type="search"
				placeholder="Filter…"
				bind:value={filter}
				aria-label="Filter file names"
			/>
			{#if filter}
				<button
					type="button"
					class="clear-btn"
					title="Clear filter"
					aria-label="Clear filter"
					onclick={() => (filter = '')}
				>
					×
				</button>
			{/if}
		</div>
		<button
			type="button"
			class="btn icon sm"
			class:is-loading={rootLoading}
			title="Refresh"
			onclick={() => refresh()}
			aria-label="Refresh"
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M13.5 3.5v3.5h-3.5" />
				<path d="M13 7A5.5 5.5 0 1 0 11.7 11.7" />
			</svg>
		</button>
	</div>
	<div class="filter-toggles">
		<label class="toggle">
			<input type="checkbox" bind:checked={showHidden} />
			<span>Hidden</span>
		</label>
		<label class="toggle">
			<input type="checkbox" bind:checked={showIgnored} />
			<span>Ignored</span>
		</label>
	</div>
	{#snippet renderEntries(path: string, depth: number)}
		{@const loaded = dirs[path]}
		{#if loaded?.loading && loaded.entries.length === 0}
			<div class="muted indented" style:--depth={depth}>Loading…</div>
		{:else if loaded?.error}
			<div class="error indented" style:--depth={depth}>{loaded.error}</div>
		{:else if loaded}
			{#each loaded.entries.filter((e) => matchesFilter(e.name)) as entry (entry.relPath)}
				{#if entry.type === 'directory'}
					{@const childLoaded = dirs[entry.relPath]}
					{@const expanded = childLoaded?.expanded ?? false}
					{@const badge = statusBadge(entry.containsChanges)}
					<button
						class="row dir"
						style:--depth={depth}
						class:has-changes={!!entry.containsChanges}
						onclick={() => toggleDir(entry)}
					>
						<span class="caret" class:open={expanded}>▶</span>
						<span class="icon">📁</span>
						<span class="name">{entry.name}</span>
						<DiffStat added={entry.added} removed={entry.removed} compact />
						{#if badge}
							<span class="status-pill" style:color={badge.color}>{badge.label}</span>
						{/if}
					</button>
					{#if expanded}
						{@render renderEntries(entry.relPath, depth + 1)}
					{/if}
				{:else}
					{@const badge = statusBadge(entry.status)}
					{@const sel = selectedPath === entry.relPath}
					<button
						class="row file"
						class:selected={sel}
						class:has-changes={!!entry.status}
						style:--depth={depth}
						onclick={() => pickFile(entry)}
					>
						<span class="caret-spacer"></span>
						<span class="icon">{entry.type === 'symlink' ? '🔗' : '📄'}</span>
						<span class="name">{entry.name}</span>
						<DiffStat added={entry.added} removed={entry.removed} compact />
						{#if badge}
							<span class="status-pill" style:color={badge.color}>{badge.label}</span>
						{/if}
					</button>
				{/if}
			{:else}
				<div class="muted indented" style:--depth={depth}>(empty)</div>
			{/each}
		{/if}
	{/snippet}
	<div class="entries">
		{@render renderEntries('', 0)}
	</div>
</div>

<style>
	.tree-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		font-size: var(--fs-sm);
		overflow: hidden;
	}
	.panel-toolbar {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.search-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
	}
	.search-icon {
		position: absolute;
		left: 0.5rem;
		color: var(--text-muted);
		pointer-events: none;
	}
	.search-wrap input[type='search'] {
		width: 100%;
		min-width: 0;
		height: 28px;
		padding: 0 1.6rem 0 1.9rem;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font: inherit;
	}
	.search-wrap input[type='search']::-webkit-search-cancel-button {
		appearance: none;
	}
	.clear-btn {
		position: absolute;
		right: 0.25rem;
		top: 50%;
		transform: translateY(-50%);
		width: 1.25rem;
		height: 1.25rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 0;
		color: var(--text-muted);
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-size: var(--fs-lg);
		line-height: 1;
		padding: 0;
	}
	.clear-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.panel-toolbar :global(.btn.icon.sm) {
		width: 28px;
		height: 28px;
		flex-shrink: 0;
	}
	.is-loading :global(svg) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.filter-toggles {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-3) var(--space-2);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		cursor: pointer;
		user-select: none;
	}
	.toggle input {
		margin: 0;
		cursor: pointer;
	}
	.toggle:hover {
		color: var(--text);
	}
	.entries {
		overflow: auto;
		flex: 1;
		min-height: 0;
		min-width: 0;
		padding: var(--space-1) 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		min-width: 0;
		max-width: 100%;
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
		background: transparent;
		border: 0;
		text-align: left;
		color: var(--text);
		font: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.row:hover {
		background: var(--surface-hover);
	}
	.row.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.caret {
		display: inline-block;
		flex: 0 0 auto;
		width: 0.75rem;
		transition: transform 100ms;
		color: var(--text-muted);
		font-size: var(--fs-xs);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.caret-spacer {
		display: inline-block;
		flex: 0 0 auto;
		width: 0.75rem;
	}
	.icon {
		flex: 0 0 auto;
		width: 1em;
		text-align: center;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.has-changes .name {
		color: var(--warning);
	}
	.row.file.has-changes .name {
		color: var(--warning);
	}
	.status-pill {
		font-family: var(--mono);
		font-weight: 600;
		font-size: var(--fs-xs);
		padding: 0 0.25rem;
		flex: 0 0 auto;
	}
	.muted {
		color: var(--text-muted);
		font-style: italic;
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
	.error {
		color: var(--danger);
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
	.indented {
		padding-left: calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
</style>
