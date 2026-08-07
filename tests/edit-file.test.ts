import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEditFileTools } from '../src/lib/server/tools/edit-file';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-edit-file-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

function tool(workspace: string, name: 'create_file' | 'replace_lines' | 'replace_text') {
	return buildEditFileTools(workspace).find((candidate) => candidate.name === name)!;
}

describe('create_file', () => {
	it('creates a file and missing parent directories in the local workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'create_file').handler({
				path: 'nested/file.txt',
				content: 'hello\n',
				worktree: '.'
			});

			expect(result).toMatchObject({
				ok: true,
				result: { path: 'nested/file.txt', size: 6 }
			});
			expect(await readFile(join(workspace, 'nested', 'file.txt'), 'utf8')).toBe('hello\n');
		});
	});

	it('refuses to overwrite an existing file', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'original');

			const result = await tool(workspace, 'create_file').handler({
				path: 'file.txt',
				content: 'replacement'
			});

			expect(result).toMatchObject({ ok: false, error: { code: 'file_exists' } });
			expect(await readFile(path, 'utf8')).toBe('original');
		});
	});
});

describe('replace_lines', () => {
	it('replaces an inclusive line range and preserves CRLF endings', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'one\r\ntwo\r\nthree\r\n');

			const result = await tool(workspace, 'replace_lines').handler({
				path: 'file.txt',
				startLine: 2,
				endLine: 2,
				content: 'TWO\nSECOND'
			});

			expect(result).toMatchObject({ ok: true });
			expect(await readFile(path, 'utf8')).toBe('one\r\nTWO\r\nSECOND\r\nthree\r\n');
		});
	});

	it('rejects a stale range without writing', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'one\ntwo\n');

			const result = await tool(workspace, 'replace_lines').handler({
				path: 'file.txt',
				startLine: 2,
				endLine: 3,
				content: 'changed'
			});

			expect(result).toMatchObject({
				ok: false,
				error: { code: 'invalid_line_range' }
			});
			expect(await readFile(path, 'utf8')).toBe('one\ntwo\n');
		});
	});
});

describe('replace_text', () => {
	it('limits exact replacements to a line range and maximum count', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'old\nold old\nold\n');

			const result = await tool(workspace, 'replace_text').handler({
				path: 'file.txt',
				oldText: 'old',
				newText: 'new',
				startLine: 2,
				endLine: 2,
				maxReplacements: 1,
				worktree: '.'
			});

			expect(result).toMatchObject({ ok: true, result: { replacements: 1 } });
			expect(await readFile(path, 'utf8')).toBe('old\nnew old\nold\n');
		});
	});

	it('fails without writing when exact text is absent', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'unchanged\n');

			const result = await tool(workspace, 'replace_text').handler({
				path: 'file.txt',
				oldText: 'missing',
				newText: 'new'
			});

			expect(result).toMatchObject({ ok: false, error: { code: 'text_not_found' } });
			expect(await readFile(path, 'utf8')).toBe('unchanged\n');
		});
	});
});
