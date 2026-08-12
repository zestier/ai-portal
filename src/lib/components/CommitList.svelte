<script lang="ts">
	import { untrack } from 'svelte';
	import type { LogEntry } from '$lib/client/file-browser';
	import { worktreeParams } from '$lib/client/file-browser';
	import Alert from './ui/Alert.svelte';

	let {
		conversationId,
		worktree = null,
		selectedSha = null,
		onselect
	}: {
		conversationId: number;
		worktree?: string | null;
		selectedSha?: string | null;
		onselect?: (sha: string) => void;
	} = $props();

	let commits = $state<LogEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let canLoadMore = $state(true);
	let initialized = $state(true);

	async function loadMore() {
		if (loading || !canLoadMore) return;
		loading = true;
		try {
			const params = worktreeParams(worktree, {
				limit: '20',
				skip: String(commits.length)
			});
			const res = await fetch(`/api/conversations/${conversationId}/git/log?${params.toString()}`);
			if (!res.ok) throw new Error(await res.text());
			const data = (await res.json()) as { initialized: boolean; commits: LogEntry[] };
			if (!data.initialized) {
				canLoadMore = false;
				initialized = false;
				return;
			}
			initialized = true;
			commits = [...commits, ...data.commits];
			if (data.commits.length < 20) canLoadMore = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void conversationId;
		void worktree;
		untrack(() => {
			commits = [];
			canLoadMore = true;
			error = null;
			initialized = true;
			loadMore();
		});
	});

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}
</script>

<div class="commit-list">
	{#if error}
		<div class="error-wrap"><Alert kind="error">{error}</Alert></div>
	{/if}
	<div class="commits">
		{#each commits as c (c.sha)}
			<button
				class="commit"
				class:selected={selectedSha === c.sha}
				onclick={() => onselect?.(c.sha)}
				title={c.subject}
			>
				<div class="row1">
					<code class="sha">{c.shortSha}</code>
					<span class="subject">{c.subject}</span>
				</div>
				<div class="row2 small muted">
					<span>{c.author}</span>
					<span>·</span>
					<span>{fmtDate(c.timestamp)}</span>
				</div>
			</button>
		{/each}
		{#if commits.length === 0 && initialized && !loading}
			<div class="muted small empty">No commits yet.</div>
		{/if}
		{#if !initialized}
			<div class="muted small empty">Not a git repository.</div>
		{/if}
		{#if canLoadMore && commits.length > 0}
			<button class="load-more" onclick={loadMore} disabled={loading}>
				{loading ? 'Loading…' : 'Load more'}
			</button>
		{/if}
	</div>
</div>

<style>
	.commit-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		font-size: var(--fs-sm);
	}
	.sha {
		font-family: var(--mono);
		color: var(--text-muted);
		font-size: var(--fs-sm);
	}
	.small {
		font-size: var(--fs-xs);
	}
	.muted {
		color: var(--text-muted);
	}
	.commits {
		overflow: auto;
		flex: 1;
		min-height: 0;
		padding: var(--space-1) 0;
	}
	.commit {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		border-bottom: 1px solid var(--border);
		color: var(--text);
		font: inherit;
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
	}
	.commit:hover {
		background: var(--surface-hover);
	}
	.commit.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.row1 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.subject {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row2 {
		margin-top: 0.15rem;
		display: flex;
		gap: var(--space-1);
	}
	.load-more {
		display: block;
		margin: var(--space-2) auto;
		padding: 0.3rem 0.8rem;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.error-wrap {
		padding: var(--space-2) var(--space-3);
	}
	.empty {
		padding: var(--space-3);
	}
</style>
