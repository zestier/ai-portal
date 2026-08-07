import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrepTools } from '../src/lib/server/tools/grep';
import { WorktreeSelector } from '../src/lib/server/tools/worktree-selector';

function tool(workspace: string, name: 'grep' | 'list_files') {
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

describe('worktree selector', () => {
	it('treats dot as the local workspace selector', () => {
		expect(WorktreeSelector.parse('.')).toBeUndefined();
		expect(WorktreeSelector.parse(' . ')).toBeUndefined();
		expect(WorktreeSelector.parse('lease-id')).toBe('lease-id');
	});
});

describe('grep', () => {
	it('returns bounded line matches and supports globs', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'const needle = 1;\n');
			await writeFile(join(workspace, 'two.txt'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				glob: '**/*.ts'
			});
			expect(result).toMatchObject({ ok: true, result: { matches: true, truncated: false } });
			if (result.ok) {
				expect(result.result as { output: string }).toMatchObject({
					output: expect.stringContaining('one.ts:1:const needle = 1;')
				});
			}
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
				maxMatches: 500
			});
			expect(result).toMatchObject({ ok: true, result: { matches: true, truncated: true } });
			if (result.ok) {
				expect(Buffer.byteLength((result.result as { output: string }).output)).toBeLessThanOrEqual(
					100_000
				);
			}
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
			expect(result).toMatchObject({ ok: true, result: { matches: true } });
		});
	});

	it('can return only file and line locations', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle one\nother\nneedle two\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output: 'lines'
			});

			expect(result).toMatchObject({ ok: true });
			if (result.ok) {
				expect((result.result as { output: string }).output).toBe('one.ts:1\none.ts:3\n');
			}
		});
	});

	it('can return only unique matching files', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'needle\nneedle\n');
			await writeFile(join(workspace, 'two.ts'), 'needle\n');
			const result = await tool(workspace, 'grep').handler({
				pattern: 'needle',
				output: 'files'
			});

			expect(result).toMatchObject({ ok: true });
			if (result.ok) {
				expect((result.result as { output: string }).output.trim().split('\n').sort()).toEqual([
					'one.ts',
					'two.ts'
				]);
			}
		});
	});
});

describe('list_files', () => {
	it('lists matching files with ignore rules and bounded output', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'src'));
			await mkdir(join(workspace, 'ignored'));
			await writeFile(join(workspace, '.gitignore'), 'ignored/\n');
			await writeFile(join(workspace, 'src', 'one.ts'), '');
			await writeFile(join(workspace, 'src', 'two.ts'), '');
			await writeFile(join(workspace, 'src', 'three.txt'), '');
			await writeFile(join(workspace, 'ignored', 'hidden.ts'), '');

			const result = await tool(workspace, 'list_files').handler({
				glob: ['**/*.ts'],
				maxResults: 1
			});

			expect(result).toMatchObject({
				ok: true,
				result: { files: ['src/one.ts'], count: 1, truncated: true }
			});
		});
	});

	it('rejects a path outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'list_files').handler({ path: '..' });
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});
});
