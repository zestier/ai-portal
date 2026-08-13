import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFindTools } from '../src/lib/server/tools/find';
import type { PortalTool } from '../src/lib/server/tools/types';

function tool(root: string): PortalTool {
	const found = buildFindTools(root)[0];
	if (!found) throw new Error('find tool not registered');
	return found;
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-find-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

function findText(result: { ok: boolean; views?: { type: string; text?: string }[] }): string {
	if (!result.ok) throw new Error('expected ok result');
	return result.views?.[0]?.text ?? '';
}

describe('find', () => {
	it('returns matching files relative to the search root', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'src'));
			await writeFile(join(workspace, 'src', 'app.ts'), '');
			await writeFile(join(workspace, 'src', 'util.ts'), '');
			await writeFile(join(workspace, 'README.md'), '');

			const result = await tool(workspace).handler({ pattern: '**/*.ts' });
			const view = findText(result);
			expect(view.split('\n').sort()).toEqual(['src/app.ts', 'src/util.ts']);
			expect(result).toMatchObject({ ok: true, result: { pattern: '**/*.ts', path: '.' } });
		});
	});

	it('renders "No files found matching pattern" when nothing matches', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace).handler({ pattern: '*.nomatch' });
			expect(result).toMatchObject({ ok: true });
			expect(findText(result)).toBe('No files found matching pattern');
		});
	});

	it('respects .gitignore', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, '.gitignore'), 'ignored/\n');
			await mkdir(join(workspace, 'ignored'));
			await writeFile(join(workspace, 'ignored', 'hidden.ts'), '');
			await writeFile(join(workspace, 'kept.ts'), '');

			const view = findText(await tool(workspace).handler({ pattern: '**/*.ts' }));
			expect(view.split('\n')).toEqual(['kept.ts']);
		});
	});

	it('excludes node_modules even when not gitignored', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true });
			await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), '');
			await writeFile(join(workspace, 'own.js'), '');

			const view = findText(await tool(workspace).handler({ pattern: '**/*.js' }));
			expect(view.split('\n')).toEqual(['own.js']);
		});
	});

	it('scopes to the given path and rejects paths outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			await mkdir(join(workspace, 'src'));
			await writeFile(join(workspace, 'src', 'app.ts'), '');
			await writeFile(join(workspace, 'root.ts'), '');

			const scoped = await tool(workspace).handler({ pattern: '**/*.ts', path: 'src' });
			expect(findText(scoped).split('\n')).toEqual(['app.ts']);

			const escaped = await tool(workspace).handler({ pattern: '**/*.ts', path: '..' });
			expect(escaped).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});

	it('caps results at the requested limit', async () => {
		await withWorkspace(async (workspace) => {
			for (let i = 0; i < 20; i++)
				await writeFile(join(workspace, `f${String(i).padStart(2, '0')}.ts`), '');
			const result = await tool(workspace).handler({ pattern: '**/*.ts', limit: 5 });
			// pi appends a `[5 results limit reached…]` notice; the listing itself
			// is capped at five results.
			const view = findText(result);
			expect(view.split('\n').filter(Boolean).slice(0, 5)).toHaveLength(5);
			expect(view).toContain('results limit reached');
		});
	});

	it('derives a read permission request on the resolved path', async () => {
		await withWorkspace(async (workspace) => {
			const derive = tool(workspace).derivePermissionRequest;
			expect(derive).toBeDefined();
			expect(derive?.({ pattern: '*.ts', path: 'src' })).toEqual({
				permissionKind: 'read',
				path: join(workspace, 'src')
			});
			expect(derive?.({ pattern: '*.ts', path: '..' })).toBeNull();
		});
	});
});
