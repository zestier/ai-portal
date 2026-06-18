import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
	GrantInputSchema,
	GrantScopeSchema,
	expectedScopeKind,
	permissionKindForTool,
	refineScopeToolAlignment
} from '../src/lib/permissions/scope-schema';
import { GRANT_TOOLS, grantToolLabel } from '../src/lib/permissions/metadata';
import {
	buildGrantScopeJson,
	defaultGrantScopeFormFields,
	grantScopeToFormFields
} from '../src/lib/permissions/grant-form';
import {
	capabilityRuleKindForScope,
	describeGrantScope
} from '../src/lib/permissions/scope-summary';

const future = Date.now() + 60_000;
const shell = (token: string, rest: Record<string, unknown> = {}) => ({
	command: [{ token }],
	...rest
});

describe('GrantInputSchema — valid shapes', () => {
	it('shell with workspace-paths positionals', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: shell('cd', { positionals: { kind: 'workspace-paths' } })
			}
		});
		expect(parsed.scope.kind).toBe('shell');
		if (parsed.scope.kind === 'shell') {
			expect(parsed.scope.rule.command?.[0]?.token).toBe('cd');
		}
		expect(parsed.expiresAt).toBeNull();
	});

	it('shell with session-workspace-paths positionals', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: shell('cat', { positionals: { kind: 'session-workspace-paths' } })
			}
		});
		expect(parsed.scope.kind).toBe('shell');
	});

	it('shell with pre-subcommand and post-subcommand option rules', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: {
					command: [
						{
							token: 'git',
							options: {
								allow: [{ name: '-C', kind: 'option', value: { kind: 'any' } }],
								deny: ['--git-dir']
							}
						},
						{
							token: 'log',
							options: {
								allow: [{ name: '--oneline', kind: 'flag' }],
								deny: ['--format']
							}
						}
					]
				}
			}
		});
		expect(parsed.scope.kind).toBe('shell');
	});

	it('fs read with workspace glob path rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'glob', value: 'src/**/*.ts' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with absolute glob path rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'glob', value: '/tmp/**/*.ts' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with omitted perms (covers all kinds)', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'fs', rule: { kind: 'path', root: 'workspace', behavior: 'any' } }
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('fs read with session-workspace rule', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'session-workspace', behavior: 'any' }
			}
		});
		expect(parsed.scope.kind).toBe('fs');
	});

	it('url with host-suffix', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'url',
			decision: 'allow',
			scope: { kind: 'url', rule: { kind: 'host-suffix', suffix: 'github.com' } }
		});
		expect(parsed.scope.kind).toBe('url');
	});

	it('with future expiry', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('ls') },
			expiresAt: future
		});
		expect(parsed.expiresAt).toBe(future);
	});

	it('accepts prompt grants without denyReason', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'prompt',
			scope: { kind: 'shell', rule: shell('npm') }
		});
		expect(parsed.decision).toBe('prompt');
		expect(parsed.denyReason).toBeNull();
	});

	it('accepts prompt grants with a trimmed denyReason', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'prompt',
			scope: { kind: 'shell', rule: shell('npm') },
			denyReason: '  Human approval required for npm scripts.  '
		});
		expect(parsed.decision).toBe('prompt');
		expect(parsed.denyReason).toBe('Human approval required for npm scripts.');
	});

	it('lowercases url host scopes at store time', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'url',
			decision: 'allow',
			scope: { kind: 'url', rule: { kind: 'host', host: 'API.GitHub.Com' } }
		});
		expect(parsed.scope.kind).toBe('url');
		if (parsed.scope.kind === 'url' && parsed.scope.rule.kind === 'host') {
			expect(parsed.scope.rule.host).toBe('api.github.com');
		}
	});

	it('lowercases url host-suffix scopes at store time', () => {
		const parsed = GrantInputSchema.parse({
			tool: 'url',
			decision: 'allow',
			scope: { kind: 'url', rule: { kind: 'host-suffix', suffix: 'GitHub.Com' } }
		});
		expect(parsed.scope.kind).toBe('url');
		if (parsed.scope.kind === 'url' && parsed.scope.rule.kind === 'host-suffix') {
			expect(parsed.scope.rule.suffix).toBe('github.com');
		}
	});
});

describe('GrantInputSchema — rejections', () => {
	it('rejects {kind:any} scope (no wildcard grants from form)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'any' }
		});
		expect(r.success).toBe(false);
	});

	it('rejects tool/scope-kind mismatch (shell tool, fs scope)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'fs', rule: { kind: 'path', root: 'workspace', behavior: 'any' } }
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.some((i) => i.message.includes('requires scope.kind'))).toBe(true);
		}
	});

	it('rejects tool/scope-kind mismatch (read tool, shell scope)', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('ls') }
		});
		expect(r.success).toBe(false);
	});

	it('rejects argv0 with a slash', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('/usr/bin/ls') }
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs absolute exact with a relative path', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'exact', value: 'relative/foo' }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs workspace glob with an absolute value', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'read',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'glob', value: '/tmp/**/*.ts' }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects fs perms that do not include the chosen tool', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'write',
			decision: 'allow',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'any' }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects expiry in the past', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('ls') },
			expiresAt: Date.now() - 1000
		});
		expect(r.success).toBe(false);
	});

	it('rejects option name without leading dash', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: {
				kind: 'shell',
				rule: { command: [{ token: 'git', options: { deny: ['foo'] } }] }
			}
		});
		expect(r.success).toBe(false);
	});

	it('rejects denyReason on an allow grant', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('ls') },
			denyReason: 'this should not be settable on an allow'
		});
		expect(r.success).toBe(false);
	});

	it('rejects pipeline value that is not "must"/"forbid"', () => {
		const r = GrantInputSchema.safeParse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('grep', { pipeline: 'sometimes' }) }
		});
		expect(r.success).toBe(false);
	});
});

describe('GrantInputSchema — denyReason + pipeline', () => {
	it('accepts denyReason on a deny grant and trims it', () => {
		const r = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'deny',
			scope: { kind: 'shell', rule: shell('cat', { pipeline: 'forbid' }) },
			denyReason: '  prefer the view tool  '
		});
		expect(r.denyReason).toBe('prefer the view tool');
		if (r.scope.kind === 'shell') {
			expect(r.scope.rule.pipeline).toBe('forbid');
		}
	});

	it('normalizes empty / whitespace / undefined / null denyReason to null', () => {
		for (const decision of ['deny', 'prompt'] as const) {
			for (const reason of [undefined, null, '', '   ']) {
				const r = GrantInputSchema.parse({
					tool: 'shell',
					decision,
					scope: { kind: 'shell', rule: shell('rm') },
					denyReason: reason
				});
				expect(r.denyReason).toBeNull();
			}
		}
	});

	it('rejects denyReason over 500 chars for deny and prompt grants', () => {
		for (const decision of ['deny', 'prompt'] as const) {
			const r = GrantInputSchema.parse({
				tool: 'shell',
				decision,
				scope: { kind: 'shell', rule: shell('rm') },
				denyReason: 'x'.repeat(500)
			});
			expect(r.denyReason).toBe('x'.repeat(500));
		}

		for (const decision of ['deny', 'prompt'] as const) {
			const r = GrantInputSchema.safeParse({
				tool: 'shell',
				decision,
				scope: { kind: 'shell', rule: shell('rm') },
				denyReason: 'x'.repeat(501)
			});
			expect(r.success).toBe(false);
		}
	});

	it('accepts pipeline=must', () => {
		const r = GrantInputSchema.parse({
			tool: 'shell',
			decision: 'allow',
			scope: { kind: 'shell', rule: shell('grep', { pipeline: 'must' }) }
		});
		if (r.scope.kind === 'shell') {
			expect(r.scope.rule.pipeline).toBe('must');
		}
	});
});

describe('refineScopeToolAlignment — shared by GrantInputSchema and request_permission_grant', () => {
	// Minimal zod wrapper so the helper can be exercised in isolation, mirroring
	// how both real schemas call it from their `superRefine`.
	const Schema = z
		.object({ tool: z.enum(GRANT_TOOLS), scope: GrantScopeSchema })
		.superRefine(refineScopeToolAlignment);

	it('accepts a scope whose kind matches the tool', () => {
		expect(
			Schema.safeParse({
				tool: 'shell',
				scope: { kind: 'shell', rule: shell('pnpm') }
			}).success
		).toBe(true);
	});

	it('rejects a scope kind that does not match the tool, citing scope.kind', () => {
		const r = Schema.safeParse({
			tool: 'shell',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } }
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.some((i) => i.path.join('.') === 'scope.kind')).toBe(true);
		}
	});

	it('rejects fs perms that exclude the chosen tool, citing scope.perms', () => {
		const r = Schema.safeParse({
			tool: 'write',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'workspace', behavior: 'any' }
			}
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.some((i) => i.path.join('.') === 'scope.perms')).toBe(true);
		}
	});

	it('accepts fs scope with omitted perms (covers all kinds)', () => {
		expect(
			Schema.safeParse({
				tool: 'write',
				scope: { kind: 'fs', rule: { kind: 'path', root: 'workspace', behavior: 'any' } }
			}).success
		).toBe(true);
	});
});

describe('permissionKindForTool', () => {
	it('maps tool to permission kind 1:1', () => {
		for (const tool of GRANT_TOOLS) {
			expect(permissionKindForTool(tool)).toBe(tool);
		}
	});

	it('centralizes grant tool metadata used by schema and settings forms', () => {
		expect(GRANT_TOOLS).toEqual(['shell', 'read', 'write', 'edit', 'url']);
		expect(expectedScopeKind('shell')).toBe('shell');
		expect(expectedScopeKind('url')).toBe('url');
		expect(expectedScopeKind('read')).toBe('fs');
		expect(expectedScopeKind('write')).toBe('fs');
		expect(expectedScopeKind('edit')).toBe('fs');
		expect(grantToolLabel('shell')).toBe('shell (run a command)');
		expect(grantToolLabel('read')).toBe('read (file read)');
	});
});

describe('grant form metadata helpers', () => {
	it('builds shell, fs, and url scope JSON through shared form helpers', () => {
		const shellFields = {
			...defaultGrantScopeFormFields(),
			shellArgv0: 'git',
			shellSubcommands: 'status',
			shellPositionals: 'any' as const,
			shellStepOptions: [
				{ allow: '--no-pager', deny: '--git-dir' },
				{ allow: '', deny: '' }
			]
		};
		expect(JSON.parse(buildGrantScopeJson('shell', shellFields).json ?? '')).toEqual({
			kind: 'shell',
			rule: {
				command: [
					{
						token: 'git',
						options: { allow: [{ name: '--no-pager', kind: 'flag' }], deny: ['--git-dir'] }
					},
					{ token: 'status' }
				],
				positionals: { kind: 'any' }
			}
		});

		const fsFields = {
			...defaultGrantScopeFormFields(),
			fsRoot: 'workspace' as const,
			fsBehavior: 'glob' as const,
			fsValue: 'src/**/*.ts'
		};
		expect(JSON.parse(buildGrantScopeJson('read', fsFields).json ?? '')).toEqual({
			kind: 'fs',
			perms: ['read'],
			rule: { kind: 'path', root: 'workspace', behavior: 'glob', value: 'src/**/*.ts' }
		});

		const urlFields = {
			...defaultGrantScopeFormFields(),
			urlRuleKind: 'host-suffix' as const,
			urlSuffix: 'github.com'
		};
		expect(JSON.parse(buildGrantScopeJson('url', urlFields).json ?? '')).toEqual({
			kind: 'url',
			rule: { kind: 'host-suffix', suffix: 'github.com' }
		});
	});

	it('initializes edit form fields from existing grant scopes', () => {
		const { fields, originalShellCommand } = grantScopeToFormFields({
			kind: 'shell',
			rule: {
				command: [
					{
						token: 'git',
						options: { allow: [{ name: '-C', kind: 'option', value: { kind: 'any' } }] }
					},
					{ token: 'log' }
				],
				pipeline: 'forbid'
			}
		});
		expect(fields.shellArgv0).toBe('git');
		expect(fields.shellSubcommands).toBe('log');
		expect(fields.shellPipeline).toBe('forbid');
		expect(fields.shellStepOptions[0].allow).toBe('-C=any');
		expect(originalShellCommand?.map((step) => step.token)).toEqual(['git', 'log']);
	});

	it('shares grant scope descriptions between settings and capability surfaces', () => {
		const scope = {
			kind: 'fs' as const,
			perms: ['read' as const],
			rule: {
				kind: 'path' as const,
				root: 'workspace' as const,
				behavior: 'prefix' as const,
				value: 'src'
			}
		};
		expect(describeGrantScope({ scope, scopePattern: null })).toBe('[read] <workspace>/src/**');
		expect(capabilityRuleKindForScope(scope)).toBe('filesystem');
	});
});
