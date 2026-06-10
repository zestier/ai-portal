// Single source of truth for the reserved `followUpHint` strings that tools set
// on a successful `ToolResult` envelope. Keeping them here (rather than inline in
// a tool handler) avoids coupling an unrelated tool's module to the domain it is
// nudging toward — e.g. the git wrapper does not author ticket-subsystem prose,
// it just opts into a named, shared hint.

// Set by `git_commit` on every successful commit: a generic nudge to reconcile
// workspace tickets. The text is intentionally tool-agnostic about *which*
// commit it followed.
export const COMMIT_TICKET_FOLLOW_UP_HINT =
	'If this commit completes or advances any workspace ticket, update it with ticket_update (or review open ones with ticket_list).';
