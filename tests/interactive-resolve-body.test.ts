import { describe, it, expect } from 'vitest';
import { Body } from '../src/lib/server/runtime/interactive-resolve-body';

// Wire-contract regression for the interactive resolve route.
//
// The `request_permission_grant` dialog reuses the full Settings scope editor,
// so an approved grant response can carry any structured `GrantScope`: shell
// pipelines/option rules, every fs root + behavior, and url scopes. A prior
// version of this route validated `scope` against a hand-rolled narrow subset
// (absolute exact/prefix fs + bare shell command only, no url), so saving such
// a grant produced a 400. The client treats a non-OK resolve POST as a
// transient failure and silently re-shows the prompt — so to the user, hitting
// "Save grant" appeared to do nothing. These tests pin the route to accepting
// the same scope shapes the editor (and the grant tool args) can produce.

function permissionAllowAlways(scope: unknown) {
	return Body.safeParse({
		kind: 'permission',
		decision: 'allow-always',
		scope: { permissionKind: 'shell', scope },
		applyToAllConversations: false
	});
}

describe('interactive resolve Body schema — grant scope shapes', () => {
	it('accepts a url host grant scope', () => {
		const res = permissionAllowAlways({
			kind: 'url',
			rule: { kind: 'host', host: 'registry.npmjs.org' }
		});
		expect(res.success).toBe(true);
	});

	it('accepts a workspace-rooted fs grant scope with behavior "any"', () => {
		const res = permissionAllowAlways({
			kind: 'fs',
			perms: ['write'],
			rule: { kind: 'path', root: 'workspace', behavior: 'any' }
		});
		expect(res.success).toBe(true);
	});

	it('accepts a glob fs grant scope under the session workspace', () => {
		const res = permissionAllowAlways({
			kind: 'fs',
			perms: ['read'],
			rule: { kind: 'path', root: 'session-workspace', behavior: 'glob', value: 'src/**/*.ts' }
		});
		expect(res.success).toBe(true);
	});

	it('accepts a shell grant scope with a pipeline constraint and option rules', () => {
		const res = permissionAllowAlways({
			kind: 'shell',
			rule: {
				command: [
					{
						token: 'pnpm',
						options: { allow: [{ name: '--filter', kind: 'option', value: { kind: 'any' } }] }
					}
				],
				positionals: { kind: 'workspace-paths' },
				pipeline: 'forbid'
			}
		});
		expect(res.success).toBe(true);
	});

	it('still accepts the narrow shell command shape the picker emits', () => {
		const res = permissionAllowAlways({
			kind: 'shell',
			rule: { command: [{ token: 'pnpm' }], positionals: { kind: 'workspace-paths' } }
		});
		expect(res.success).toBe(true);
	});

	it('rejects a structurally invalid scope (argv0 with a slash)', () => {
		const res = permissionAllowAlways({
			kind: 'shell',
			rule: { command: [{ token: '/bin/sh' }] }
		});
		expect(res.success).toBe(false);
	});
});
