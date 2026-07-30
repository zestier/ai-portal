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
//
// The guidance is assembled from the tools a given session actually exposes so
// it never pressures the agent toward tools that aren't available. A session
// with the `tickets` group disabled, for example, gets no ticket-workflow
// paragraph at all — previously the ticket-first mandate was sent unconditionally
// and bogged down lighter or non-engineering work even when the tools were gone.

// Marker tool names used to detect which optional tool groups a session exposes.
// Checking one representative name per group avoids re-listing every tool.
const GIT_TOOL_MARKER = 'git_status';
const TICKET_TOOL_MARKER = 'ticket_add';
const WORKTREE_TOOL_MARKER = 'worktree_create';
const PERMISSION_TOOL_MARKERS = ['permission_capabilities', 'request_permission_grant'] as const;

/**
 * Build the standing, portal-wide system guidance for a session, tailored to the
 * tools that session actually exposes. Tool-specific paragraphs (git, tickets,
 * permissions) are only included when the corresponding tools are present, so a
 * session that has disabled a group is never told to reach for tools it lacks.
 *
 * @param availableToolNames names of the portal tools this session exposes.
 */
export function buildPortalSystemGuidance(availableToolNames: Iterable<string>): string {
	const names =
		availableToolNames instanceof Set ? availableToolNames : new Set(availableToolNames);
	const blocks: string[] = [];

	blocks.push(
		[
			'You are running through a portal that mediates your tool calls via a permission gateway.',
			'Prefer structured tools (view/edit/create/grep/glob) over shell equivalents (cat/sed/rg/find) where available.'
		].join('\n')
	);

	if (names.has(GIT_TOOL_MARKER)) {
		blocks.push(
			'Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit instead of shell git.'
		);
	}

	if (names.has(TICKET_TOOL_MARKER)) {
		blocks.push(
			[
				'Ticket tools (ticket_add/ticket_list/ticket_update) track durable, multi-step work that outlives a',
				'single session. When a task is substantial engineering work spanning multiple steps or sessions, prefer',
				'a ticket over ephemeral session state: check ticket_list first and resume the matching ticket (read its',
				'`plan`) before re-planning, or open one if none fits. Keep the plan and checklist in the ticket `plan`',
				'field, update status as you work, and file discovered follow-up work as linked tickets (ticket_block) so',
				'ordering stays navigable. This is a convenience for durable work, not a blanket requirement — skip it for',
				'lighter, one-off, or non-engineering tasks where a ticket would add overhead without payoff.'
			].join('\n')
		);
	}

	if (names.has(WORKTREE_TOOL_MARKER)) {
		blocks.push(
			[
				'When you delegate work to several sub-agents at once, give each one its own worktree',
				'(worktree_create) instead of letting them all edit the shared working tree — concurrent',
				'edits to one tree corrupt each other, and git state is per-tree. Pass the sub-agent the',
				'ABSOLUTE path you got back and tell it to do all of its work there and nowhere else; the',
				'directory already exists and is writable, so it should not try to create it. Never point',
				'two sub-agents at the same worktree.',
				'',
				'Finish the loop: a worktree whose work you never merge is work you threw away. Tell each',
				'sub-agent to COMMIT in its worktree when done (uncommitted changes cannot be merged) with',
				'git_commit and that worktree\'s id — `git_commit { worktree: "<leaseId>", paths: "all", ... }`;',
				'shell git is not available there. Then worktree_merge it back into this conversation and',
				'worktree_remove it. Pass `squash` (with a subject naming the unit of work) on the way back:',
				"it collapses the worktree's commits into one, so this conversation gets one clean commit per",
				"worktree instead of the sub-agent's intermediate history. If a worktree is behind because",
				'another one landed first, sync it with direction "from-source" and then retry the squash —',
				'that keeps history linear where allowMergeCommit would add a merge commit. worktree_list',
				'shows `ahead` — commits waiting to be merged — so you can see what is outstanding.',
				'',
				'For a single sequential task, just work in the normal workspace — worktrees are for',
				'parallelism, not a default.'
			].join('\n')
		);
	}

	if (PERMISSION_TOOL_MARKERS.some((name) => names.has(name))) {
		blocks.push(
			[
				'Use permission_capabilities to inspect allowed alternatives after permission rejections.',
				'Use `forcePermissionPrompt` sparingly for a one-off unblock: only after verifying no',
				'allowed alternative works, and include a concise reason. Reserve `request_permission_grant`',
				'for explicit persistence intent (a durable, saved rule) — not in-the-moment unblocks.'
			].join('\n')
		);
	}

	return blocks.join('\n\n');
}

// Full guidance with every optional section present. Retained for callers and
// tests that want the complete text; live sessions use `buildPortalSystemGuidance`
// with their real tool set so absent tool groups drop their paragraphs.
export const PORTAL_SYSTEM_GUIDANCE = buildPortalSystemGuidance([
	GIT_TOOL_MARKER,
	TICKET_TOOL_MARKER,
	WORKTREE_TOOL_MARKER,
	...PERMISSION_TOOL_MARKERS
]);
