import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrepTools, type GrepResult } from '../../../src/lib/server/tools/grep';
import { WorktreeSelector } from '../../../src/lib/server/tools/worktree-selector';

function tool(workspace: string, name: 'grep') {
	return buildGrepTools(workspace).find((candidate) => candidate.name === name)!;
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-grep-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

function grepResult(result: { ok: boolean; result?: unknown }): GrepResult {
	if (!result.ok) throw new Error('expected ok result');
	return result.result as GrepResult;
}

describe('worktree selector', () => {
	it('treats dot as the local workspace selector', () => {
		expect(WorktreeSelector.parse('.')).toBeUndefined();
		expect(WorktreeSelector.parse(' . ')).toBeUndefined();
		expect(WorktreeSelector.parse('lease-id')).toBe('lease-id');
	});
});

describe('grep', () => {
	it('defaults to files_with_matches and supports globs', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'const needle = 1;\n');
			await writeFile(join(workspace, 'two.txt'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				glob: '**/*.ts'
			});
			expect(grepResult(result)).toMatchObject({
				mode: 'files_with_matches',
				numFiles: 1,
				filenames: ['one.ts'],
				totalFiles: 1
			});
		});
	});

	it('returns content lines in rg path:line:content form', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle one\nother\nneedle two\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'content',
				path: 'one.ts'
			});
			expect(grepResult(result)).toMatchObject({
				mode: 'content',
				numLines: 2,
				totalLines: 2,
				content: 'one.ts:1:needle one\none.ts:3:needle two'
			});
		});
	});

	it('omits line numbers when -n is false', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'content',
				path: 'one.ts',
				'-n': false
			});
			expect(grepResult(result)).toMatchObject({ content: 'one.ts:needle' });
		});
	});

	it('honors context around matches in content mode', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle one\nother\nneedle two\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'content',
				path: 'one.ts',
				context: 1
			});
			expect(grepResult(result)).toMatchObject({
				content: 'one.ts:1:needle one\none.ts-2-other\none.ts:3:needle two'
			});
		});
	});

	it('returns unique matching files in files_with_matches mode', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle\nneedle\n');
			await writeFile(join(workspace, 'two.ts'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'files_with_matches'
			});
			const parsed = grepResult(result);
			expect(parsed).toMatchObject({ mode: 'files_with_matches', numFiles: 2, totalFiles: 2 });
			expect([...(parsed.filenames ?? [])].sort()).toEqual(['one.ts', 'two.ts']);
		});
	});

	it('returns per-file match counts in count mode', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle\nother\nneedle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'count',
				path: 'one.ts'
			});
			expect(grepResult(result)).toMatchObject({
				mode: 'count',
				numFiles: 1,
				numMatches: 2,
				filenames: ['one.ts']
			});
		});
	});

	it('rejects a path outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				path: '..'
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});

	it('caps output returned from the WASM runtime', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'large.txt'), `${'needle '.padEnd(300, 'x')}\n`.repeat(500));
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output_mode: 'content',
				head_limit: 0
			});
			const parsed = grepResult(result);
			expect(parsed.truncated).toBe(true);
			expect(parsed.numLines).toBe(500);
			expect(parsed.content).toContain('[truncated: results exceed 100KB]');
		});
	});

	it('returns ripgrep errors as tool errors', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'grep').handler({ pattern: '[' });
			expect(result).toMatchObject({ ok: false, error: { code: 'grep_failed' } });
		});
	});

	it('accepts dot as the local workspace', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				worktree: '.'
			});
			expect(grepResult(result)).toMatchObject({ mode: 'files_with_matches', numFiles: 1 });
		});
	});
});
