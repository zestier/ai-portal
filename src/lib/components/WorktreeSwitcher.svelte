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

	let {
		conversationId,
		selected = null,
		onselect
	}: {
		conversationId: string;
		selected?: string | null;
		onselect?: (leaseId: string | null) => void;
	} = $props();

	let worktrees = $state<WorktreeOption[]>([]);

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
		{/if}
	</div>
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
</style>
