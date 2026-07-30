import { writable } from 'svelte/store';

/**
 * Revision counter for "a worktree's merge state may have just changed".
 *
 * The unmerged indicators (the sidebar badge and the chat header pill) describe
 * a git fact, and git changes underneath the UI: an agent commits mid-turn, or a
 * merge lands. Neither indicator can observe that on its own — the header only
 * fetched on conversation switch, and the sidebar only on a slow poll — so both
 * went stale until a reload. Rather than poll harder (each read costs several
 * git subprocesses per worktree), the moments that can plausibly change the
 * answer bump this counter and the indicators refetch.
 *
 * Deliberately a bare counter rather than a per-conversation signal: a commit in
 * ANY checkout moves the source branch, which changes every other worktree's
 * ahead/behind. Scoping the invalidation to the conversation that caused it
 * would leave the rest stale for exactly the reason this exists.
 */
export const worktreeStatusRevision = writable(0);

/** Signal that worktree merge state may have changed; indicators refetch. */
export function invalidateWorktreeStatus(): void {
	worktreeStatusRevision.update((n) => n + 1);
}
