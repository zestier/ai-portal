import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitTools } from '../src/lib/server/tools/git';
import { buildMemoryTools } from '../src/lib/server/tools/memory';
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

	it('returns ok:true for tools without an argsSchema', () => {
		expect(
			validatePortalToolArgs(
				{
					name: 'no-schema',
					description: 'x',
					parameters: {},
					async handler() {
						return '';
					}
				},
				{ anything: 1 }
			)
		).toEqual({ ok: true });
	});

	it('returns the full patch shape when memory_propose_patch args are invalid', () => {
		const proposePatch = buildMemoryTools({
			userId: 'u1',
			conversationId: 'c1',
			mode: 'project'
		}).find((t) => t.name === 'memory_propose_patch');
		if (!proposePatch) throw new Error('memory_propose_patch tool not found');
		// Missing required `value` on a fact — previously the feedback only
		// surfaced an opaque `{ type: 'object' }`, leaving the agent unable to
		// see the patch shape it needed to fix.
		const result = validatePortalToolArgs(proposePatch, {
			patch: { facts: [{ predicate: 'color' }] }
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unreachable');
		expect(result.feedback).toMatch(/Expected JSON Schema for "memory_propose_patch" parameters:/);
		expect(result.feedback).toMatch(/resolveOpenLoops/);
		expect(result.feedback).toMatch(/entityKey/);
		expect(result.feedback).toMatch(/"predicate"/);
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
