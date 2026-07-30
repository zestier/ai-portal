<script lang="ts">
	// Workspace switcher for the Files/Changes/Commits panes.
	//
	// A conversation's agent can create worktree leases and hand them to parallel
	// sub-agents. Without this control that work is invisible: every read
	// endpoint defaults to the conversation's own workspace, so an orchestrator
	// run would be functional but unreviewable.
	//
	// Renders nothing when no leases exist, so an ordinary conversation's UI is
	// unchanged.

	import { untrack } from 'svelte';
	import { fetchWorktrees, type WorktreeOption } from '$lib/client/file-browser';
	import { invalidateWorktreeStatus } from '$lib/client/worktree-status';

	let {
		conversationId,
		selected = null,
		onselect,
		onmerged
	}: {
		conversationId: string;
		selected?: string | null;
		onselect?: (leaseId: string | null) => void;
		/** Fired after a successful merge so the panes re-read both trees. */
		onmerged?: () => void;
	} = $props();

	let worktrees = $state<WorktreeOption[]>([]);
	let merging = $state(false);
	let mergeError = $state<string | null>(null);
	let mergeNotice = $state<string | null>(null);

	async function load() {
		try {
			worktrees = await fetchWorktrees(conversationId);
		} catch {
			// A failed lookup should not break the file browser; fall back to
			// showing no switcher, which leaves the primary workspace selected.
			worktrees = [];
		}
	}

	$effect(() => {
		void conversationId;
		untrack(() => {
			load();
		});
	});

	const active = $derived(worktrees.find((w) => w.id === selected) ?? null);

	// A selected lease that has disappeared (reaped, or removed by the agent
	// mid-view) must not silently show the primary workspace's contents under
	// its name — fall back explicitly and tell the user.
	const selectedMissing = $derived(selected !== null && worktrees.length > 0 && active === null);

	$effect(() => {
		if (selectedMissing) onselect?.(null);
	});

	function choose(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		onselect?.(value === '' ? null : value);
	}

	/**
	 * Merge the selected worktree's commits back into this conversation.
	 *
	 * Retries once with `allowMergeCommit` when a fast-forward is not possible:
	 * collecting the second and later worktrees of a parallel run always needs a
	 * merge commit, so failing there would make the button useless in exactly
	 * the case it exists for. A conflict is NOT retried — it is reported.
	 */
	async function mergeSelected() {
		if (!active || merging) return;
		merging = true;
		mergeError = null;
		mergeNotice = null;
		try {
			let res = await postMerge(active.id, false);
			if (res.status === 409) {
				const body = await res.json().catch(() => null);
				if (body?.code === 'not_fast_forwardable') {
					res = await postMerge(active.id, true);
				} else {
					mergeError = body?.message ?? 'Merge failed';
					return;
				}
			}
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				mergeError = body?.message ?? `Merge failed (${res.status})`;
				return;
			}
			const { merge } = await res.json();
			mergeNotice = merge.merged
				? `Merged into ${merge.into}`
				: `Already up to date with ${merge.into}`;
			await load();
			// Merging a lease into the conversation's branch moves that branch, so
			// the conversation's own unmerged indicators are now out of date.
			invalidateWorktreeStatus();
			onmerged?.();
		} catch (e) {
			mergeError = e instanceof Error ? e.message : String(e);
		} finally {
			merging = false;
		}
	}

	function postMerge(leaseId: string, allowMergeCommit: boolean) {
		return fetch(`/api/conversations/${conversationId}/worktrees/${leaseId}/merge`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ direction: 'to-source', allowMergeCommit })
		});
	}
</script>

{#if worktrees.length > 0}
	<div class="switcher">
		<label class="control">
			<span class="label">Workspace</span>
			<select
				value={selected ?? ''}
				onchange={choose}
				title={active?.path ?? undefined}
				data-testid="worktree-switcher"
			>
				<option value="">Main workspace</option>
				{#each worktrees as w (w.id)}
					<option value={w.id} disabled={!w.available}>
						{w.label}
						{#if !w.available}(unavailable){:else if w.dirtyCount}({w.dirtyCount} changed){/if}
					</option>
				{/each}
			</select>
		</label>
		{#if active}
			<!-- The branch is deliberately NOT repeated here: GitStatusHeader renders
			     it directly below for whichever workspace is selected. Per-message
			     snapshots only capture the conversation's own tree, though, so say
			     that rather than letting the user assume Changes covers everything. -->
			<span class="note">Not snapshotted per message</span>
			{#if active.ahead}
				<button
					type="button"
					class="btn small"
					disabled={merging || (active.dirtyCount ?? 0) > 0}
					title={(active.dirtyCount ?? 0) > 0
						? 'Commit or discard this worktree’s uncommitted changes first'
						: 'Merge this worktree’s commits into the conversation’s workspace'}
					onclick={mergeSelected}
					data-testid="worktree-merge"
				>
					{merging ? 'Merging…' : `Merge ${active.ahead} commit${active.ahead === 1 ? '' : 's'}`}
				</button>
			{:else if active.available}
				<span class="note" data-testid="worktree-merged">Nothing to merge</span>
			{/if}
		{/if}
	</div>
	{#if mergeError}
		<div class="merge-msg error" role="alert">{mergeError}</div>
	{:else if mergeNotice}
		<div class="merge-msg" role="status">{mergeNotice}</div>
	{/if}
{/if}

<style>
	.switcher {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.35rem 0.6rem;
		border-bottom: 1px solid var(--border);
		background-color: var(--surface);
		font-size: var(--fs-sm);
	}
	.control {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}
	.label {
		color: var(--text-muted);
		white-space: nowrap;
	}
	select {
		max-width: 16rem;
		padding: 0.15rem 0.3rem;
		font-size: var(--fs-sm);
		color: var(--text);
		background-color: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
	}
	.note {
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-style: italic;
		white-space: nowrap;
	}
	.merge-msg {
		padding: 0.3rem 0.6rem;
		border-bottom: 1px solid var(--border);
		background-color: var(--surface);
		color: var(--text-muted);
		font-size: var(--fs-xs);
	}
	.merge-msg.error {
		color: var(--danger, #b3261e);
	}
</style>
