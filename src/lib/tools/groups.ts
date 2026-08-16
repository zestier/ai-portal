// Canonical list of portal-injected tool groups that a conversation can
// disable on a per-session basis. This is the single source of truth shared by
// the providers (which assemble + filter the tools) and the UI (which renders a
// checkbox per group), so the ids never drift between server and client.
//
// This module is deliberately client-safe (no `$lib/server` imports) so the
// chat header can import the ids/labels directly.

export interface PortalToolGroup {
	id: PortalToolGroupId;
	/** Human-readable label shown in the settings UI. */
	label: string;
	/** Short helper text describing what disabling the group costs. */
	hint: string;
}

export type PortalToolGroupId =
	| 'shell'
	| 'git'
	| 'filesystem'
	| 'worktree'
	| 'tickets'
	| 'permissions'
	| 'memory'
	| 'prompt-templates'
	| 'interaction';

export const PORTAL_TOOL_GROUPS: readonly PortalToolGroup[] = [
	{ id: 'shell', label: 'Shell', hint: 'Run supervised, workspace-scoped Bash commands.' },
	{ id: 'git', label: 'Git', hint: 'Structured git status/diff/log/show/commit tools.' },
	{
		id: 'filesystem',
		label: 'Filesystem',
		hint: 'Workspace-scoped file discovery, reading, editing, moving, and trash helpers.'
	},
	{
		id: 'worktree',
		label: 'Worktrees',
		hint: 'Create and manage isolated checkouts so parallel sub-agents don’t collide in one tree.'
	},
	{ id: 'tickets', label: 'Tickets', hint: 'Durable workspace ticket create/list/update tools.' },
	{
		id: 'permissions',
		label: 'Permissions',
		hint: 'Self-service permission tools. Disabling removes the agent’s ability to request durable grants mid-session.'
	},
	{
		id: 'memory',
		label: 'Memory',
		hint: 'Portal memory tools. Already empty when memory mode is off; this is an extra gate on top.'
	},
	{
		id: 'prompt-templates',
		label: 'Prompt templates',
		hint: 'Stored chat/ticket prompt-template management tools.'
	},
	{
		id: 'interaction',
		label: 'Ask user',
		hint: 'Let the agent pause to ask you a question mid-turn (question dialog, no permission effect).'
	}
] as const;

export const PORTAL_TOOL_GROUP_IDS: readonly PortalToolGroupId[] = PORTAL_TOOL_GROUPS.map(
	(g) => g.id
);

const PORTAL_TOOL_GROUP_ID_SET: ReadonlySet<string> = new Set(PORTAL_TOOL_GROUP_IDS);

export function isPortalToolGroupId(value: unknown): value is PortalToolGroupId {
	return typeof value === 'string' && PORTAL_TOOL_GROUP_ID_SET.has(value);
}

/**
 * Normalize an arbitrary value into a clean set of disabled group ids: keep
 * only recognized ids, drop unknown/duplicate entries, and preserve the
 * canonical group order for deterministic storage/output. Accepts anything
 * (JSON-parsed row values, request bodies) and never throws.
 */
export function sanitizeDisabledToolGroups(value: unknown): PortalToolGroupId[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<PortalToolGroupId>();
	for (const entry of value) {
		if (isPortalToolGroupId(entry)) seen.add(entry);
	}
	return PORTAL_TOOL_GROUP_IDS.filter((id) => seen.has(id));
}
