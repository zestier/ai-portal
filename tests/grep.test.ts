import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrepTools } from '../src/lib/server/tools/grep';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-grep-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

describe('grep', () => {
	it('returns bounded line matches and supports globs', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'one.ts'), 'const needle = 1;\n');
			await writeFile(join(workspace, 'two.txt'), 'needle\n');
			const result = await buildGrepTools(workspace)[0].handler({
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
			const result = await buildGrepTools(workspace)[0].handler({
				pattern: 'needle',
				path: '..'
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});
});
