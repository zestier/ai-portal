// Zod schemas mirroring the discriminated unions in `scope-types.ts`.
//
// Kept in a separate file so `scope-types.ts` stays framework-free
// (it's imported from both client and server bundles). These schemas
// are the source of truth for form-driven grant authoring and the codec's
// defensive validation of persisted JSON.

import { z } from 'zod';
import {
	FS_PERMISSIONS,
	FS_RULE_BEHAVIORS_WITH_VALUE,
	FS_RULE_CONTAINER_ROOTS
} from './scope-types';
import { GRANT_TOOLS, expectedScopeKind, permissionKindForTool } from './metadata';
import type { GrantScope } from './scope-types';

const ArgvToken = z
	.string()
	.min(1)
	.refine((s) => !s.includes('\0'), 'must not contain NUL');

const Argv0Schema = ArgvToken.refine(
	(s) => !s.includes('/') && !s.startsWith('.'),
	'argv0 must be a bare command name (no slashes, no leading dot)'
);

const PositionalsSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('any') }),
	z.object({ kind: z.literal('workspace-paths') }),
	z.object({ kind: z.literal('session-workspace-paths') })
]);

const FlagSchema = z
	.string()
	.min(1)
	.refine((s) => s.startsWith('-'), 'option names must start with `-`');

const ShellOptionValueSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('any') }),
	z.object({ kind: z.literal('workspace-path') })
]);

const ShellOptionSpecSchema = z.discriminatedUnion('kind', [
	z.object({
		name: FlagSchema,
		kind: z.literal('flag')
	}),
	z.object({
		name: FlagSchema,
		kind: z.literal('option'),
		value: ShellOptionValueSchema
	})
]);

const ShellOptionRulesSchema = z
	.object({
		allow: z.array(ShellOptionSpecSchema).min(1).optional(),
		deny: z.array(FlagSchema).min(1).optional()
	})
	.refine((f) => f.allow !== undefined || f.deny !== undefined, {
		message: 'option rules must specify at least one of allow/deny'
	});

const ShellCommandStepSchema = z.object({
	token: ArgvToken,
	options: ShellOptionRulesSchema.optional()
});

const ShellRuleSchema = z.object({
	command: z
		.array(ShellCommandStepSchema)
		.min(1)
		.refine((steps) => Argv0Schema.safeParse(steps[0]?.token).success, {
			message: 'first command token must be a bare command name'
		}),
	positionals: PositionalsSchema.optional(),
	pipeline: z.enum(['must', 'forbid']).optional()
});

const ShellScopeSchema = z.object({
	kind: z.literal('shell'),
	rule: ShellRuleSchema
});

const AbsolutePathSchema = z
	.string()
	.min(1)
	.refine((s) => !s.includes('\0'), 'path must not contain NUL')
	.refine((s) => s.startsWith('/'), 'path must be absolute (start with /)');

const RelativePathPatternSchema = z
	.string()
	.min(1)
	.refine((s) => !s.includes('\0'), 'value must not contain NUL')
	.refine((s) => !s.startsWith('/'), 'value must be relative for workspace roots');

const FsRuleSchema = z.union([
	z
		.object({
			kind: z.literal('path'),
			root: z.enum(FS_RULE_CONTAINER_ROOTS),
			behavior: z.literal('any')
		})
		.strict(),
	z
		.object({
			kind: z.literal('path'),
			root: z.literal('absolute'),
			behavior: z.enum(FS_RULE_BEHAVIORS_WITH_VALUE),
			value: AbsolutePathSchema
		})
		.strict(),
	z
		.object({
			kind: z.literal('path'),
			root: z.enum(FS_RULE_CONTAINER_ROOTS),
			behavior: z.enum(FS_RULE_BEHAVIORS_WITH_VALUE),
			value: RelativePathPatternSchema
		})
		.strict()
]);

export const FsScopeSchema = z
	.object({
		kind: z.literal('fs'),
		perms: z.array(z.enum(FS_PERMISSIONS)).min(1).optional(),
		rule: FsRuleSchema
	})
	.strict();

const UrlRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('exact'), url: z.string().min(1).url() }),
	z.object({
		kind: z.literal('host'),
		host: z
			.string()
			.min(1)
			.transform((s) => s.toLowerCase())
	}),
	z.object({
		kind: z.literal('host-suffix'),
		suffix: z
			.string()
			.min(1)
			.transform((s) => s.toLowerCase())
	})
]);

const UrlScopeSchema = z.object({
	kind: z.literal('url'),
	rule: UrlRuleSchema
});

/**
 * Structured grant scopes the form is allowed to author. Note that
 * `{kind:'any'}` is deliberately omitted — it's a migration-era catch-all
 * for v2 rows without a structured shape, and we don't want users
 * minting new wildcard grants from the UI.
 */
export const GrantScopeSchema: z.ZodType<Exclude<GrantScope, { kind: 'any' }>> =
	z.discriminatedUnion('kind', [ShellScopeSchema, FsScopeSchema, UrlScopeSchema]);

/**
 * Full payload for the "create grant" form action. Validates that the
 * chosen `tool` / `permissionKind` are consistent with the scope shape;
 * the matcher relies on this alignment (a `tool='shell'` row with an
 * fs-shaped scope would simply never match anything, but we reject it
 * up front so the user sees a clear error).
 */
export const GrantInputSchema = z
	.object({
		tool: z.enum(GRANT_TOOLS),
		decision: z.enum(['allow', 'deny', 'prompt']),
		scope: GrantScopeSchema,
		/** Unix ms. `null` = never expires. */
		expiresAt: z
			.number()
			.int()
			.positive()
			.nullable()
			.optional()
			.transform((v) => v ?? null),
		/**
		 * Optional human-readable feedback surfaced to the agent when this
		 * grant denies a request or when a prompt-required grant has to
		 * auto-deny because no human prompt can be shown.
		 */
		denyReason: z
			.string()
			.trim()
			.max(500, 'deny reason must be at most 500 characters')
			.nullable()
			.optional()
			.transform((v) => (v === undefined || v === null || v === '' ? null : v))
	})
	.superRefine((val, ctx) => {
		const expected = expectedScopeKind(val.tool);
		if (val.scope.kind !== expected) {
			ctx.addIssue({
				code: 'custom',
				path: ['scope', 'kind'],
				message: `tool=${val.tool} requires scope.kind=${expected}, got ${val.scope.kind}`
			});
			return;
		}

		// fs: if the form passes `perms`, ensure it includes the tool kind.
		// We don't *require* perms (omitting it means "all three fs kinds"),
		// but if it's set it must cover the tool the user picked.
		if (val.scope.kind === 'fs' && val.scope.perms && val.scope.perms.length > 0) {
			const tool = val.tool as 'read' | 'write' | 'edit';
			if (!val.scope.perms.includes(tool)) {
				ctx.addIssue({
					code: 'custom',
					path: ['scope', 'perms'],
					message: `perms must include "${tool}" (the chosen tool) or be omitted`
				});
			}
		}

		// Expiry sanity: must be in the future when provided.
		if (val.expiresAt !== null && val.expiresAt !== undefined && val.expiresAt <= Date.now()) {
			ctx.addIssue({
				code: 'custom',
				path: ['expiresAt'],
				message: 'expiry must be in the future'
			});
		}

		// denyReason only makes sense on deny/prompt grants. Don't silently
		// drop it; better to flag the inconsistency.
		if (val.denyReason !== null && val.decision !== 'deny' && val.decision !== 'prompt') {
			ctx.addIssue({
				code: 'custom',
				path: ['denyReason'],
				message: 'denyReason is only allowed on deny or prompt grants'
			});
		}
	});

export type GrantInput = z.infer<typeof GrantInputSchema>;
export { expectedScopeKind, permissionKindForTool };
