import { z } from 'zod';
import { GrantScopeSchema } from '$lib/permissions/scope-schema';

// Per-kind response schemas for the interactive-resolve HTTP route. The body
// must include `kind` so we can route to the right shape; the server-side
// registry then verifies the kind matches the pending request before applying
// any side effects.
//
// These live in a standalone module (not the `+server.ts` route) because
// SvelteKit only permits route handler exports (GET/POST/...) from route
// files. Keeping them here lets the route and the wire-contract tests share a
// single source of truth.

// Structured scope wire shape. We validate against the canonical
// `GrantScopeSchema` — the single source of truth shared by the in-chat
// permission/grant dialogs, the Settings grant form, and the
// `request_permission_grant` tool args. The shell permission picker emits a
// narrow subset (command + coarse positionals); the grant-request dialog
// reuses the full Settings scope editor and can emit shell pipelines/option
// rules, every fs root/behavior, and url scopes. The schema accepts all of
// them so a legitimate dialog response is never silently rejected at the wire
// (which previously surfaced to the user as the prompt reappearing with no
// effect). The codec re-validates on the way to the DB as defense in depth.
export const PermissionScope = z.object({
	permissionKind: z.string().min(1).max(64).nullable().optional(),
	pattern: z.string().max(1024).nullable().optional(),
	scope: GrantScopeSchema.optional()
});

const PermissionBody = z.object({
	kind: z.literal('permission'),
	decision: z.enum(['allow-once', 'allow-always', 'deny', 'deny-always']),
	feedback: z
		.string()
		.trim()
		.max(500, 'feedback must be at most 500 characters')
		.optional()
		.transform((v) => (v === undefined || v === '' ? undefined : v)),
	scope: PermissionScope.optional(),
	// Multi-grant payload. The shell picker may persist several
	// per-argv0 grants from one click; we cap the array to keep abuse
	// surface tiny. Each entry is validated as a full PermissionScope.
	additionalScopes: z.array(PermissionScope).max(16).optional(),
	applyToAllConversations: z.boolean().optional(),
	// Cap at 30 days to keep "time-limited" meaningful.
	expiresInMs: z
		.number()
		.int()
		.positive()
		.max(30 * 24 * 60 * 60 * 1000)
		.optional()
});

const AutoModeSwitchBody = z.object({
	kind: z.literal('auto_mode_switch'),
	decision: z.enum(['yes', 'no'])
});

const UserInputBody = z.object({
	kind: z.literal('user_input'),
	answer: z.string(),
	wasFreeform: z.boolean().optional()
});

const ElicitationContent = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);

const ElicitationBody = z.object({
	kind: z.literal('elicitation'),
	action: z.enum(['accept', 'decline', 'cancel']),
	content: ElicitationContent.optional()
});

const InfoAckBody = z.object({
	kind: z.enum(['sampling', 'mcp_oauth', 'external_tool']),
	action: z.literal('ack')
});

const WorkspaceFileBody = z.object({
	kind: z.literal('workspace_file'),
	decision: z.enum(['approve', 'reject'])
});

export const Body = z.discriminatedUnion('kind', [
	PermissionBody,
	AutoModeSwitchBody,
	UserInputBody,
	ElicitationBody,
	InfoAckBody,
	WorkspaceFileBody
]);
