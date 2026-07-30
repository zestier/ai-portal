// Single source of truth for the reserved `followUpHint` strings that tools set
// on a successful `ToolResult` envelope. Keeping them here (rather than inline in
// a tool handler) avoids coupling an unrelated tool's module to the domain it is
// nudging toward — e.g. the git wrapper does not author ticket-subsystem prose,
// it just opts into a named, shared hint.

// Set by `git_commit` on every successful commit: a nudge to actively
// reconcile workspace tickets (review open ones, update any this commit
// advanced). The text is intentionally tool-agnostic about *which* commit it
// followed.
export const COMMIT_TICKET_FOLLOW_UP_HINT =
	'Now reconcile workspace tickets: review the open ones with ticket_list and, for any that this commit completes or advances, update them with ticket_update.';

// Appended to `COMMIT_TICKET_FOLLOW_UP_HINT` when the commit landed in a linked
// worktree. Commits made there are invisible to the source checkout until they
// are merged back, which is the single easiest thing for an agent to forget at
// the end of a worktree session.
export const WORKTREE_INTEGRATE_FOLLOW_UP_HINT =
	'This commit landed on a linked worktree branch, so it is not yet in the source checkout. When the work is complete, integrate it with git_worktree_merge (direction "to-source"); use git_worktree_status first if you need the ahead/behind counts.';

// Set by `git_commit` when the commit was made INTO a lease this conversation
// holds (`worktree: <leaseId>`). The collecting call there is `worktree_merge`
// with that id — `git_worktree_merge` acts on the session's own workspace and
// would not touch the lease — so the hint names it explicitly.
export function leaseIntegrateFollowUpHint(leaseId: string): string {
	return (
		`This commit landed on worktree ${leaseId}'s branch, not in this conversation's workspace. ` +
		`Collect it with worktree_merge (leaseId: "${leaseId}"), then worktree_remove the worktree once you no longer need it.`
	);
}
