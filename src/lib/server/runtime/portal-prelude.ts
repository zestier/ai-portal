// Per-turn "portal context" block prepended to the user's message before
// it's handed to the SDK. Goal: tell the agent that it's running through
// a permission gateway and that reject `feedback` strings are the
// authoritative source of "why was that denied / what should I do
// instead". We deliberately do NOT enumerate the user's grants here —
// the matcher's deny `feedback` self-teaches on the first rejection,
// and dumping every rule would blow up context for no real win.
//
// This lives at the portal layer because the portal needs to work with
// arbitrary agents driven through `@github/copilot-sdk` — we can't
// assume any baked-in knowledge of how the portal mediates permissions.
//
// IMPORTANT: nothing here is authoritative. Allow/deny decisions are
// enforced by the matcher in `interactive-adapter.ts`.

export const PORTAL_PRELUDE = [
	'[Portal context — auto-injected; not authored by the user]',
	'Tool calls run through a permission gateway. On reject, the `feedback` string is',
	'authoritative — read it and adapt. Prefer structured tools (view/edit/create/grep/glob)',
	'over shell equivalents (cat/sed/rg/find) where available.',
	'Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit instead of shell git.',
	'Use ticket_add/ticket_list/ticket_update for durable workspace tickets and later-task stashes.',
	'Prefer a ticket (its `plan` field) over a scratch markdown file for any plan/checklist meant',
	'to outlive the session; record ticket ordering with ticket_block and consult it before',
	'picking work (a ticket with no open blockers is ready to start).',
	'Use permission_capabilities to inspect allowed alternatives after permission rejections.',
	'Use `forcePermissionPrompt` sparingly for a one-off unblock: only after verifying no',
	'allowed alternative works, and include a concise reason. Reserve `request_permission_grant`',
	'for explicit persistence intent (a durable, saved rule) — not in-the-moment unblocks.',
	'[/Portal context]'
].join('\n');
