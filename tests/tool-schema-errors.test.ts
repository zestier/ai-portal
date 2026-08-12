import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitTools } from '../src/lib/server/tools/git';
import { ok } from '../src/lib/server/tools/types';
import { buildMemoryTools } from '../src/lib/server/tools/memory';
import { buildTicketTools } from '../src/lib/server/tools/tickets';
import {
	buildToolArgsValidator,
	validatePortalToolArgs
} from '../src/lib/server/tools/schema-error';

function getTool(name: string) {
	const cwd = mkdtempSync(join(tmpdir(), 'portal-schema-err-'));
	try {
		const t = buildGitTools(cwd).find((x) => x.name === name);
		if (!t) throw new Error(`tool ${name} not found`);
		return t;
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe('validatePortalToolArgs', () => {
	it('returns ok:true when args match the schema', () => {
		const gitCommit = getTool('git_commit');
		expect(validatePortalToolArgs(gitCommit, { paths: 'all', subject: 'fix: thing' })).toEqual({
			ok: true
		});
	});

	it('returns ok:false with schema feedback for missing fields', () => {
		const gitCommit = getTool('git_commit');
		const result = validatePortalToolArgs(gitCommit, { paths: 'all' });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.feedback).toMatch(/Invalid arguments for tool "git_commit"/);
		expect(result.feedback).toMatch(/subject/);
		expect(result.feedback).toMatch(/Expected JSON Schema for "git_commit" parameters:/);
	});

	it('reports per-field issue paths for empty subject', () => {
		const gitCommit = getTool('git_commit');
		const result = validatePortalToolArgs(gitCommit, { paths: 'all', subject: '' });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.feedback).toMatch(/subject:/);
	});

	it('rejects a JSON-encoded ticket fields array with copyable corrected arguments', () => {
		const ticketList = buildTicketTools({
			userId: 1,
			workspaceKey: '/workspace',
			conversationId: 1
		}).find((tool) => tool.name === 'ticket_list')!;
		expect(validatePortalToolArgs(ticketList, { fields: ['id', 'title'] })).toEqual({ ok: true });

		const result = validatePortalToolArgs(ticketList, { fields: '["id","title"]' });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.feedback).toContain('fields: Expected array');
		expect(result.feedback).toContain('"type": "array"');
	});

	it('rejects an empty ticket fields array', () => {
		const ticketList = buildTicketTools({
			userId: 1,
			workspaceKey: '/workspace',
			conversationId: 1
		}).find((tool) => tool.name === 'ticket_list')!;

		const result = validatePortalToolArgs(ticketList, { fields: [] });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.feedback).toContain(
			'At least one field must be requested; omit "fields" for the compact view.'
		);
	});

	it('returns ok:true for tools without an argsSchema', () => {
		expect(
			validatePortalToolArgs(
				{
					name: 'no-schema',
					description: 'x',
					parameters: {},
					async handler() {
						return ok('');
					}
				},
				{ anything: 1 }
			)
		).toEqual({ ok: true });
	});

	it('no longer exposes memory_propose_patch to the main model', () => {
		// Durable writes are owned by the background extractor's per-kind
		// remember_* tools; the main model has no direct memory write tool.
		const proposePatch = buildMemoryTools({
			userId: 1,
			conversationId: 1,
			mode: 'project'
		}).find((t) => t.name === 'memory_propose_patch');
		expect(proposePatch).toBeUndefined();
	});
});

describe('buildToolArgsValidator', () => {
	it('returns null for unknown tools, valid args, and a failure for invalid args', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'portal-schema-err-'));
		try {
			const validate = buildToolArgsValidator(buildGitTools(cwd));
			expect(validate('not_a_tool', {})).toBeNull();
			expect(validate('git_commit', { paths: 'all', subject: 's' })).toBeNull();
			const bad = validate('git_commit', { paths: 'all' });
			expect(bad?.feedback).toMatch(/Expected JSON Schema for "git_commit" parameters:/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
