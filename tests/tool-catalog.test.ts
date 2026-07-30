import { describe, it, expect } from 'vitest';
import { portalToolCatalog } from '../src/lib/server/tools/catalog';
import { customToolGrantCaveat } from '../src/lib/tools/catalog-types';
import { PORTAL_TOOL_GROUP_IDS } from '../src/lib/tools/groups';
import { matchGrants } from '../src/lib/server/permissions/matcher';

const byName = (name: string) => {
	const entry = portalToolCatalog().find((t) => t.name === name);
	if (!entry) throw new Error(`no catalog entry for ${name}`);
	return entry;
};

describe('portalToolCatalog', () => {
	it('enumerates tools from every group without touching the DB', () => {
		const catalog = portalToolCatalog();
		const groups = new Set(catalog.map((t) => t.group));
		for (const id of PORTAL_TOOL_GROUP_IDS) {
			expect(groups.has(id), `group ${id} contributed no tools`).toBe(true);
		}
	});

	it('has unique names', () => {
		const names = portalToolCatalog().map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('lists the mutating worktree tools the seed set deliberately omits', () => {
		// The whole point of the settings custom-tool form: these are absent from
		// `defaultSeedGrants()` on purpose, so the user must be able to find them
		// by name to opt in.
		const names = portalToolCatalog().map((t) => t.name);
		expect(names).toContain('worktree_create');
		expect(names).toContain('worktree_remove');
		expect(names).toContain('worktree_merge');
	});

	it('reports the permission behavior a grant has to contend with', () => {
		expect(byName('worktree_create').permissionBehavior).toBe('normal');
		expect(byName('worktree_remove').permissionBehavior).toBe('always-prompt');
		expect(byName('git_commit').permissionBehavior).toBe('always-prompt');
	});

	it('flags tools whose permission is re-expressed as a filesystem request', () => {
		expect(byName('move').filesystemDerived).toBe(true);
		expect(byName('worktree_create').filesystemDerived).toBe(false);
	});
});

describe('customToolGrantCaveat', () => {
	it('says nothing for a tool a grant can actually govern', () => {
		expect(customToolGrantCaveat(byName('worktree_create'))).toBeNull();
	});

	it('warns that always-prompt tools cannot be auto-approved by a grant', () => {
		// `alwaysPrompt` is evaluated before grant matching in the interactive
		// adapter, so the row would be saved and then never consulted.
		expect(customToolGrantCaveat(byName('worktree_remove'))).toMatch(/always prompts/);
		expect(customToolGrantCaveat(byName('git_commit'))).toMatch(/always prompts/);
	});

	it('warns that never-prompt tools are already approved', () => {
		expect(customToolGrantCaveat(byName('memory_search'))).toMatch(/never prompts/);
	});

	it('warns that filesystem-derived tools are governed by fs grants', () => {
		expect(customToolGrantCaveat(byName('move'))).toMatch(/filesystem/);
	});
});

describe('a settings-authored custom-tool grant matches a real request', () => {
	// End-to-end shape check: what the form persists (tool = the NAME,
	// permissionKind = 'custom-tool', scope = {kind:'any'}) is exactly what the
	// matcher looks for, so the row is indistinguishable from a seeded one.
	const row = {
		tool: 'worktree_create',
		permissionKind: 'custom-tool',
		scopePattern: null,
		scope: { kind: 'any' } as const,
		decision: 'allow' as const,
		expiresAt: null,
		argsHash: null,
		denyReason: null,
		conversationId: null
	};

	it('allows the named tool', () => {
		expect(
			matchGrants([row], {
				tool: 'worktree_create',
				permissionKind: 'custom-tool',
				scopeKey: null,
				now: Date.now()
			})
		).toBe('allow');
	});

	it('does not leak onto a different tool', () => {
		expect(
			matchGrants([row], {
				tool: 'worktree_remove',
				permissionKind: 'custom-tool',
				scopeKey: null,
				now: Date.now()
			})
		).toBe('none');
	});

	it('supports deny with agent-facing feedback', () => {
		expect(
			matchGrants([{ ...row, decision: 'deny', denyReason: 'ask a human' }], {
				tool: 'worktree_create',
				permissionKind: 'custom-tool',
				scopeKey: null,
				now: Date.now()
			})
		).toBe('deny');
	});
});
