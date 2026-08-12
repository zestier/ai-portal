<script lang="ts">
	import { untrack } from 'svelte';
	import { fetchHeadStatus, worktreeParams, type HeadStatus } from '$lib/client/file-browser';
	import Alert from './ui/Alert.svelte';
	import ConfirmDialog from './ui/ConfirmDialog.svelte';

	let {
		conversationId,
		worktree = null,
		refreshToken = 0,
		onrevert
	}: {
		conversationId: number;
		worktree?: string | null;
		refreshToken?: number;
		onrevert?: () => void;
	} = $props();

	let head = $state<HeadStatus | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let reverting = $state(false);
	let confirmOpen = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			head = await fetchHeadStatus(conversationId, worktree);
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
			head = null;
			load();
		});
	});

	function requestRevert() {
		if (!head?.initialized || head.dirtyCount === 0 || reverting) return;
		confirmOpen = true;
	}

	function cancelRevert() {
		confirmOpen = false;
	}

	async function confirmRevert() {
		if (!head?.initialized || head.dirtyCount === 0 || reverting) return;

		reverting = true;
		error = null;
		try {
			// Must carry the worktree selector: this discards uncommitted work, and
			// reverting a tree other than the one on screen would be silent data loss.
			const params = worktreeParams(worktree);
			const query = params.size > 0 ? `?${params}` : '';
			const res = await fetch(`/api/conversations/${conversationId}/git/changes/revert${query}`, {
				method: 'POST'
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			onrevert?.();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			reverting = false;
			confirmOpen = false;
		}
	}
</script>

<div class="git-status" aria-label="Git status">
	{#if error}
		<Alert kind="error">{error}</Alert>
	{:else if head === null}
		<span class="muted small">{loading ? 'Loading…' : ''}</span>
	{:else if head.initialized === false}
		<span class="muted small">Not a git repository</span>
	{:else}
		<div class="row1">
			<span class="branch" title={head.detached ? 'Detached HEAD' : (head.branch ?? '')}>
				<span class="branch-icon" aria-hidden="true">⎇</span>
				<strong>{head.branch ?? '(detached)'}</strong>
			</span>
			{#if head.shortSha}<code class="sha">@ {head.shortSha}</code>{/if}
		</div>
		<div class="row2 small">
			{#if head.upstream}
				<span class="muted" title={`Tracking ${head.upstream}`}>
					<code>{head.upstream}</code>
				</span>
				{#if head.ahead}<span class="ahead" title="Commits ahead of upstream">↑{head.ahead}</span
					>{/if}
				{#if head.behind}<span class="behind" title="Commits behind upstream">↓{head.behind}</span
					>{/if}
				{#if !head.ahead && !head.behind}<span class="muted in-sync" title="In sync with upstream"
						>·</span
					>{/if}
			{:else}
				<span class="muted">no upstream</span>
			{/if}
			{#if head.dirtyCount > 0}
				<span class="dirty" title="Uncommitted changes in the working tree">
					● {head.dirtyCount} change{head.dirtyCount === 1 ? '' : 's'}
				</span>
			{:else}
				<span class="clean" title="Working tree clean">✓ clean</span>
			{/if}
		</div>
		<button
			type="button"
			class="btn danger sm revert-btn"
			class:is-loading={reverting}
			disabled={head.dirtyCount === 0 || reverting}
			title="Revert all local changes"
			onclick={requestRevert}
		>
			Revert all
		</button>
	{/if}
</div>

{#if head?.initialized}
	<ConfirmDialog
		open={confirmOpen}
		title="Discard all local changes?"
		confirmLabel="Revert all"
		cancelLabel="Cancel"
		danger
		busy={reverting}
		onConfirm={confirmRevert}
		onCancel={cancelRevert}
	>
		<p>
			This permanently discards
			<strong
				>{head?.dirtyCount ?? 0} uncommitted change{(head?.dirtyCount ?? 0) === 1
					? ''
					: 's'}</strong
			>
			in the working tree: tracked files are reset and untracked files are deleted. This cannot be undone.
		</p>
	</ConfirmDialog>
{/if}

<style>
	.git-status {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		position: relative;
		padding: var(--space-2) calc(var(--space-3) + 5.5rem) var(--space-2) var(--space-3);
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-sm);
	}
	.row1 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
		overflow: hidden;
	}
	.branch {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.branch strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sha {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.branch-icon {
		color: var(--text-muted);
	}
	.row2 {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}
	.sha,
	code {
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
	.ahead {
		color: var(--success);
	}
	.behind {
		color: var(--warning);
	}
	.dirty {
		color: var(--warning);
	}
	.clean {
		color: var(--success);
	}
	.revert-btn {
		position: absolute;
		right: var(--space-3);
		top: 50%;
		transform: translateY(-50%);
		white-space: nowrap;
	}
	.is-loading {
		cursor: wait;
	}
</style>
