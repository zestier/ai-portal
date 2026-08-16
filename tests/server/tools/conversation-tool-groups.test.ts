import { describe, it, expect, beforeEach } from 'vitest';
import type { PortalTool } from '../../../src/lib/server/tools/types';
import { filterPortalToolGroups } from '../../../src/lib/server/tools/filter-groups';
import {
	PORTAL_TOOL_GROUP_IDS,
	sanitizeDisabledToolGroups,
	type PortalToolGroupId
} from '../../../src/lib/tools/groups';
import * as users from '../../../src/lib/server/db/repos/users';
import * as convs from '../../../src/lib/server/db/repos/conversations';
import { setupLocalEnv } from '../../helpers/env';

function tool(name: string): PortalTool {
	return {
		name,
		description: name,
		parameters: {},
		handler: async () => ({ ok: true, result: null })
	};
}

function grouped(): Record<PortalToolGroupId, PortalTool[]> {
	return {
		shell: [tool('bash')],
		git: [tool('git_status'), tool('git_commit')],
		filesystem: [tool('create_directory')],
		worktree: [tool('worktree_create')],
		tickets: [tool('ticket_add'), tool('ticket_list')],
		permissions: [tool('request_permission_grant')],
		memory: [tool('memory_upsert')],
		'prompt-templates': [tool('template_list')]
	};
}

const names = (tools: PortalTool[]) => tools.map((t) => t.name);

describe('filterPortalToolGroups', () => {
	it('returns every tool when nothing is disabled', () => {
		const out = names(filterPortalToolGroups(grouped(), []));
		expect(out).toEqual([
			'bash',
			'git_status',
			'git_commit',
			'create_directory',
			'worktree_create',
			'ticket_add',
			'ticket_list',
			'request_permission_grant',
			'memory_upsert',
			'template_list'
		]);
	});

	it('drops a single disabled group', () => {
		const out = names(filterPortalToolGroups(grouped(), ['git']));
		expect(out).not.toContain('git_status');
		expect(out).not.toContain('git_commit');
		expect(out).toContain('ticket_add');
	});

	it('drops the worktree group when disabled', () => {
		const out = names(filterPortalToolGroups(grouped(), ['worktree']));
		expect(out).not.toContain('worktree_create');
		expect(out).toContain('create_directory');
	});

	it('drops multiple disabled groups', () => {
		const out = names(filterPortalToolGroups(grouped(), ['git', 'tickets', 'memory']));
		expect(out).toEqual([
			'bash',
			'create_directory',
			'worktree_create',
			'request_permission_grant',
			'template_list'
		]);
	});

	it('ignores unknown group ids', () => {
		const out = names(filterPortalToolGroups(grouped(), ['nope', 'git']));
		expect(out).not.toContain('git_status');
		expect(out).toContain('ticket_add');
	});

	it('can disable every group', () => {
		const out = filterPortalToolGroups(grouped(), [...PORTAL_TOOL_GROUP_IDS]);
		expect(out).toEqual([]);
	});

	it('emits groups in canonical order regardless of record insertion order', () => {
		const shuffled = {
			shell: [tool('bash')],
			'prompt-templates': [tool('template_list')],
			memory: [tool('memory_upsert')],
			permissions: [tool('request_permission_grant')],
			tickets: [tool('ticket_add')],
			worktree: [tool('worktree_create')],
			filesystem: [tool('create_directory')],
			git: [tool('git_status')]
		} as Record<PortalToolGroupId, PortalTool[]>;
		expect(names(filterPortalToolGroups(shuffled, []))).toEqual([
			'bash',
			'git_status',
			'create_directory',
			'worktree_create',
			'ticket_add',
			'request_permission_grant',
			'memory_upsert',
			'template_list'
		]);
	});
});

describe('sanitizeDisabledToolGroups', () => {
	it('keeps recognized ids, in canonical order, de-duplicated', () => {
		expect(sanitizeDisabledToolGroups(['tickets', 'git', 'git'])).toEqual(['git', 'tickets']);
	});

	it('drops unknown ids and non-arrays', () => {
		expect(sanitizeDisabledToolGroups(['git', 'bogus', 42, null])).toEqual(['git']);
		expect(sanitizeDisabledToolGroups('git')).toEqual([]);
		expect(sanitizeDisabledToolGroups(undefined)).toEqual([]);
	});
});

describe('conversations repo disabledToolGroups round-trip', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-tool-groups-test-');
	});

	it('defaults to an empty set on create', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		expect(c.disabledToolGroups).toEqual([]);
		expect(convs.get(c.id, u.id)?.disabledToolGroups).toEqual([]);
	});

	it('persists and reloads a set value', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		convs.updateSessionSettings(c.id, u.id, { disabledToolGroups: ['tickets', 'git'] });
		expect(convs.get(c.id, u.id)?.disabledToolGroups).toEqual(['git', 'tickets']);
	});

	it('sanitizes unknown ids on write', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		convs.updateSessionSettings(c.id, u.id, {
			disabledToolGroups: ['git', 'not-a-group', 'git']
		});
		expect(convs.get(c.id, u.id)?.disabledToolGroups).toEqual(['git']);
	});

	it('can clear back to empty', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		convs.updateSessionSettings(c.id, u.id, { disabledToolGroups: ['memory'] });
		convs.updateSessionSettings(c.id, u.id, { disabledToolGroups: [] });
		expect(convs.get(c.id, u.id)?.disabledToolGroups).toEqual([]);
	});

	it('accepts and sanitizes disabledToolGroups passed to create', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: 'm',
			disabledToolGroups: ['tickets', 'bogus', 'git']
		});
		expect(c.disabledToolGroups).toEqual(['git', 'tickets']);
		expect(convs.get(c.id, u.id)?.disabledToolGroups).toEqual(['git', 'tickets']);
	});
});
