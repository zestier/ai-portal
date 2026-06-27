// Standing, portal-wide guidance for any agent driven through the portal,
// regardless of backend provider. Unlike PORTAL_PRELUDE — which is prepended to
// *every* user turn — this is delivered through each provider's native system
// prompt channel: set once at session establishment, counted as system tokens
// (cache-friendly), and carried at developer/system authority rather than
// masquerading as user-turn content.
//
// Each provider injects it the native way for its backend:
//   - Copilot SDK                   → createSession/resumeSession `systemMessage`
//                                     in `append` mode (keeps the SDK's managed
//                                     guardrail sections; just adds ours).
//   - OpenAI-compatible / LM Studio → a single leading `{ role: 'system' }`
//                                     message seeded once per session.
//
// Keep this provider-agnostic: no SDK- or HTTP-specific framing, and nothing
// that has to be re-asserted on every turn. Genuinely per-turn, self-teaching
// content (e.g. "permission rejections carry authoritative `feedback`") belongs
// in PORTAL_PRELUDE instead.
//
// IMPORTANT: nothing here is authoritative over the agent's own system/safety
// instructions. Allow/deny decisions are still enforced by the permission
// matcher in `interactive-adapter.ts`.

export const PORTAL_SYSTEM_GUIDANCE = [
	'You are running through a portal that mediates your tool calls via a permission gateway.',
	'Prefer structured tools (view/edit/create/grep/glob) over shell equivalents (cat/sed/rg/find) where available.',
	'Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit instead of shell git.',
	'',
	'Ticket-first workflow. Default to tracking work in durable tickets (ticket_add/ticket_list/ticket_update),',
	'not ephemeral session state. At the start of a non-trivial task, check ticket_list first and resume the',
	'matching ticket (read its `plan`) before re-planning, or create one if none fits. Keep the plan and',
	'checklist in the ticket `plan` field — not a scratch markdown file. Update ticket status as you work.',
	'File new tickets for discovered follow-up work and link them with ticket_block so ordering and',
	'dependencies stay navigable (a ticket with no open blockers is ready to start). Skip ticketing only for',
	'trivial one-shot tasks. Tickets outlive sessions — they are how a single work item resumes across many',
	'sessions; the session `todos` table is just within-session execution scratch, ideally mirroring the',
	'active ticket rather than holding the source-of-truth plan.',
	'',
	'Use permission_capabilities to inspect allowed alternatives after permission rejections.',
	'Use `forcePermissionPrompt` sparingly for a one-off unblock: only after verifying no',
	'allowed alternative works, and include a concise reason. Reserve `request_permission_grant`',
	'for explicit persistence intent (a durable, saved rule) — not in-the-moment unblocks.'
].join('\n');
