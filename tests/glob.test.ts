import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrepTools, type GlobResult } from '../src/lib/server/tools/grep';

function tool(workspace: string) {
	return buildGrepTools(workspace).find((candidate) => candidate.name === 'glob')!;
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-glob-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

function globResult(result: { ok: boolean; result?: unknown }): GlobResult {
	if (!result.ok) throw new Error('expected ok result');
	return result.result as GlobResult;
}

// The rendered view text is what a model sees for the call; the structured
// GlobOutput payload is the `result`.
function globViewText(result: { ok: boolean; views?: { type: string; text?: string }[] }): string {
	if (!result.ok) throw new Error('expected ok result');
	return result.views?.[0]?.text ?? '';
}

describe('glob', () => {
	it('returns matching workspace-relative files with the GlobOutput shape', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'src'));
			await writeFile(join(workspace, 'src', 'app.ts'), '');
			await writeFile(join(workspace, 'src', 'util.ts'), '');
			await writeFile(join(workspace, 'README.md'), '');

			const result = await tool(workspace).handler({ pattern: '**/*.ts' });
			const parsed = globResult(result);
			expect(typeof parsed.durationMs).toBe('number');
			expect(parsed).toMatchObject({
				numFiles: 2,
				filenames: ['src/app.ts', 'src/util.ts'],
				truncated: false,
				totalMatches: 2,
				countIsComplete: true
			});
			// Rendered text is plain newline-separated filenames, no header.
			expect(globViewText(result)).toBe('src/app.ts\nsrc/util.ts');
		});
	});

	it('renders "No files found" when nothing matches', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace).handler({ pattern: '*.nomatch' });
			expect(globResult(result)).toMatchObject({ numFiles: 0, filenames: [], truncated: false });
			expect(globViewText(result)).toBe('No files found');
		});
	});

	it('lists files inside gitignored directories, matching the SDK Glob', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true });
			await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), '');
			await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');

			const result = await tool(workspace).handler({ pattern: '**/*.js' });
			expect(globResult(result).filenames).toEqual(['node_modules/dep/index.js']);
		});
	});

	it('scopes to the given path and rejects paths outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'src'));
			await writeFile(join(workspace, 'src', 'app.ts'), '');
			await writeFile(join(workspace, 'root.ts'), '');

			// Paths stay workspace-relative (like grep/list_files), even under a scoped path.
			const scoped = await tool(workspace).handler({ pattern: '**/*.ts', path: 'src' });
			expect(globResult(scoped).filenames).toEqual(['src/app.ts']);

			const escaped = await tool(workspace).handler({ pattern: '**/*.ts', path: '..' });
			expect(escaped).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});

	it('caps results at 100 files and reports the true total', async () => {
		await withWorkspace(async (workspace) => {
			for (let i = 0; i < 120; i++)
				await writeFile(join(workspace, `f${String(i).padStart(3, '0')}.ts`), '');
			const result = await tool(workspace).handler({ pattern: '**/*.ts' });
			const parsed = globResult(result);
			expect(parsed).toMatchObject({ numFiles: 100, truncated: true, totalMatches: 120 });
			expect(parsed.filenames).toHaveLength(100);
			expect(parsed.countIsComplete).toBe(true);
		});
	});

	it('does not leak the .git directory into results', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'file.txt'), '');
			const result = await tool(workspace).handler({ pattern: '**/*' });
			expect(globResult(result).filenames).not.toContain('.git/config');
			expect(globResult(result).filenames).toContain('file.txt');
		});
	});
});
