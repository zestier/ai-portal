import { FS_PERMISSIONS, type FsPermission, type GrantScope } from './scope-types';

export const GRANT_TOOLS = ['shell', 'read', 'write', 'edit', 'url'] as const;
export type GrantTool = (typeof GRANT_TOOLS)[number];
export type GrantScopeKind = Exclude<GrantScope['kind'], 'any'>;

/**
 * The permission kind portal-injected structured tools (`worktree_create`,
 * `git_status`, `ticket_add`, …) are evaluated under. Unlike the five scoped
 * kinds above it is not a scope shape: a custom-tool grant is keyed by the
 * TOOL NAME in the row's `tool` column and carries the `{kind:'any'}` scope,
 * because the tool itself is the unit of authorization — there is nothing
 * finer to scope. `defaultSeedGrants()` writes exactly this shape.
 */
export const CUSTOM_TOOL_KIND = 'custom-tool';

/**
 * Tool options the grant-authoring form offers. Broader than `GRANT_TOOLS`,
 * which stays the set of *scoped* kinds that `expectedScopeKind` /
 * `refineScopeToolAlignment` are defined over.
 */
export const GRANT_FORM_TOOLS = [...GRANT_TOOLS, CUSTOM_TOOL_KIND] as const;
export type GrantFormTool = (typeof GRANT_FORM_TOOLS)[number];

export interface PermissionScopeKeyRequest {
	fullCommandText?: string;
	fileName?: string;
	path?: string;
	url?: string;
	args?: unknown;
}

interface PermissionKindDescriptor {
	scopeKind: GrantScopeKind;
	label: string;
	grantFormLabel: string;
	autoDenyAlternativeHint: string;
	scopeKey(req: PermissionScopeKeyRequest): string | null;
}

const permissionKindDescriptors = {
	shell: {
		scopeKind: 'shell',
		label: 'shell',
		grantFormLabel: 'shell (run a command)',
		autoDenyAlternativeHint: 'Try a structured tool or another already-allowed approach first.',
		scopeKey: (req) => req.fullCommandText ?? readArgString(req.args, 'command') ?? null
	},
	read: {
		scopeKind: 'fs',
		label: 'read',
		grantFormLabel: 'read (file read)',
		autoDenyAlternativeHint:
			'Try the structured read/search tools or existing workspace context first.',
		scopeKey: (req) => req.path ?? req.fileName ?? readArgString(req.args, 'path') ?? null
	},
	write: {
		scopeKind: 'fs',
		label: 'write',
		grantFormLabel: 'write (file write)',
		autoDenyAlternativeHint:
			'Try a structured workspace edit/create workflow or another already-allowed path first.',
		scopeKey: fsWriteScopeKey
	},
	edit: {
		scopeKind: 'fs',
		label: 'edit',
		grantFormLabel: 'edit (file edit)',
		autoDenyAlternativeHint:
			'Try a structured workspace edit/create workflow or another already-allowed path first.',
		scopeKey: fsWriteScopeKey
	},
	url: {
		scopeKind: 'url',
		label: 'url',
		grantFormLabel: 'url (fetch URL)',
		autoDenyAlternativeHint:
			'Try a local source or another non-network approach first. If the answer depends on external documentation, current API behavior, or other version-specific online information, retry with `forcePermissionPrompt` instead of guessing.',
		scopeKey: (req) =>
			req.url ??
			readArgString(req.args, 'url') ??
			readArgString(req.args, 'href') ??
			req.fullCommandText ??
			null
	}
} satisfies Record<GrantTool, PermissionKindDescriptor>;

const fsPermissionKindSet = new Set<string>(FS_PERMISSIONS);
const grantToolSet = new Set<string>(GRANT_TOOLS);

/**
 * Bare tool name: what an SDK/portal tool call is keyed by. Deliberately
 * excludes `*` — the matcher treats a `*` tool as a wildcard over every tool,
 * and the form should not be able to mint one (same reasoning as omitting
 * `{kind:'any'}` from `GrantScopeSchema`).
 */
const CUSTOM_TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const CUSTOM_TOOL_NAME_MAX = 128;

/**
 * Validate a custom-tool grant's tool name, returning a human-readable message
 * or `null` when it's usable. Shared by the client form (live feedback) and
 * `GrantInputSchema` (authoritative check) so the two can't disagree.
 */
export function customToolNameError(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) return 'tool name is required';
	if (trimmed.length > CUSTOM_TOOL_NAME_MAX) {
		return `tool name must be at most ${CUSTOM_TOOL_NAME_MAX} characters`;
	}
	if (!CUSTOM_TOOL_NAME_RE.test(trimmed)) {
		return 'tool name must be a bare tool name like `worktree_create` (letters, digits, `_`, `.`, `:`, `-`; no spaces and no `*` wildcard)';
	}
	return null;
}

export function isGrantTool(tool: string): tool is GrantTool {
	return grantToolSet.has(tool);
}

/**
 * The value a grant row's `tool` column takes for a form submission. Scoped
 * kinds store the kind itself; a custom-tool grant stores the tool name, which
 * is what `matchGrants` compares against the request's tool.
 */
export function persistedGrantTool(input: {
	tool: GrantFormTool;
	toolName?: string | null;
}): string {
	if (input.tool !== CUSTOM_TOOL_KIND) return input.tool;
	return (input.toolName ?? '').trim();
}

export function isFilesystemPermissionKind(kind: string): kind is FsPermission {
	return fsPermissionKindSet.has(kind);
}

export function expectedScopeKind(tool: GrantTool): GrantScopeKind {
	return permissionKindDescriptors[tool].scopeKind;
}

export function permissionKindForTool(tool: GrantFormTool): string {
	return tool;
}

export function derivePermissionScopeKey(
	permissionKind: string,
	req: PermissionScopeKeyRequest
): string | null {
	return isGrantTool(permissionKind)
		? permissionKindDescriptors[permissionKind].scopeKey(req)
		: null;
}

export function permissionKindLabel(permissionKind: string): string {
	return isGrantTool(permissionKind) ? permissionKindDescriptors[permissionKind].label : 'unknown';
}

/**
 * Short "try this instead" hint attached to an auto-denied permission request
 * (the `auto-deny` approval mode), so the agent has a concrete next move rather
 * than just a refusal.
 */
export function autoDenyAlternativeHint(permissionKind: string): string {
	return isGrantTool(permissionKind)
		? permissionKindDescriptors[permissionKind].autoDenyAlternativeHint
		: 'Try another approach that stays within the current permission set first.';
}

export function grantToolLabel(tool: GrantFormTool): string {
	if (tool === CUSTOM_TOOL_KIND) return 'custom-tool (a portal tool, by name)';
	return permissionKindDescriptors[tool].grantFormLabel;
}

function fsWriteScopeKey(req: PermissionScopeKeyRequest): string | null {
	return req.fileName ?? req.path ?? readArgString(req.args, 'path') ?? null;
}

function readArgString(args: unknown, key: string): string | null {
	if (!args || typeof args !== 'object') return null;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}
