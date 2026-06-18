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
