<script lang="ts">
	import { untrack } from 'svelte';
	import type { ChangeEntry, ChangesResponse } from '$lib/client/file-browser';
	import { worktreeParams } from '$lib/client/file-browser';
	import DiffStat from './DiffStat.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import Alert from './ui/Alert.svelte';

	let {
		conversationId,
		worktree = null,
		selectedPath = null,
		refreshToken = 0,
		onselect,
		onrefresh
	}: {
		conversationId: string;
		worktree?: string | null;
		selectedPath?: string | null;
		refreshToken?: number;
		onselect?: (entry: ChangeEntry) => void;
		onrefresh?: () => void;
	} = $props();

	let entries = $state<ChangeEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let initialized = $state(true);
	let filter = $state('');

	async function load() {
		loading = true;
		error = null;
		try {
			const params = worktreeParams(worktree);
			const query = params.size > 0 ? `?${params}` : '';
			const res = await fetch(`/api/conversations/${conversationId}/git/changes${query}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as ChangesResponse;
			entries = data.entries;
			initialized = data.initialized;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void conversationId;
		void worktree;
		void refreshToken;
		untrack(() => {
			entries = [];
			load();
		});
	});

	function refresh() {
		load();
		onrefresh?.();
	}

	const visible = $derived(
		filter ? entries.filter((e) => e.path.toLowerCase().includes(filter.toLowerCase())) : entries
	);

	const totals = $derived.by(() => {
		let added = 0;
		let removed = 0;
		for (const e of entries) {
			if (e.added != null) added += e.added;
			if (e.removed != null) removed += e.removed;
		}
		return { added, removed };
	});
</script>

<div class="change-list">
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
				placeholder="Filter changed files…"
				bind:value={filter}
				aria-label="Filter changed files"
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
			class:is-loading={loading}
			title="Refresh"
			onclick={refresh}
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
	{#if error}
		<div class="error-wrap"><Alert kind="error">{error}</Alert></div>
	{:else if !initialized}
		<div class="muted empty">Not a git repository.</div>
	{:else if loading && entries.length === 0}
		<div class="muted empty">Loading…</div>
	{:else if entries.length === 0}
		<div class="muted empty">Working tree clean.</div>
	{:else}
		<div class="rows">
			<div class="summary muted small">
				<span>
					{entries.length} changed file{entries.length === 1 ? '' : 's'}
				</span>
				<DiffStat added={totals.added} removed={totals.removed} />
			</div>
			{#each visible as e (e.path)}
				<button
					class="row"
					class:selected={selectedPath === e.path}
					onclick={() => onselect?.(e)}
					title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}
				>
					<StatusBadge status={e.status} />
					<span class="path">
						{#if e.origPath}<span class="orig">{e.origPath} → </span>{/if}{e.path}
					</span>
					<DiffStat added={e.added} removed={e.removed} compact />
					<span class="flags small muted">
						{#if e.staged && e.unstaged}M{:else if e.staged}staged{:else}unstaged{/if}
					</span>
				</button>
			{:else}
				<div class="muted small empty">No matches.</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.change-list {
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
	.rows {
		overflow: auto;
		flex: 1;
		min-height: 0;
		min-width: 0;
		padding: var(--space-1) 0;
	}
	.summary {
		display: flex;
		gap: var(--space-2);
		align-items: baseline;
		padding: var(--space-1) var(--space-3);
		min-width: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-width: 0;
		max-width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		color: var(--text);
		font: inherit;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
	}
	.row:hover {
		background: var(--surface-hover);
	}
	.row.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.path {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.orig {
		color: var(--text-muted);
	}
	.flags {
		flex: 0 0 auto;
	}
	.small {
		font-size: var(--fs-xs);
	}
	.muted {
		color: var(--text-muted);
	}
	.empty {
		padding: var(--space-3);
		font-style: italic;
	}
	.error-wrap {
		padding: var(--space-2) var(--space-3);
	}
</style>
