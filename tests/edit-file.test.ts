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

function tool(workspace: string, name: 'write' | 'replace_lines' | 'replace_text') {
	return buildEditFileTools(workspace).find((candidate) => candidate.name === name)!;
}

describe('write', () => {
	it('creates a file and missing parent directories, reporting type create', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'write').handler({
				file_path: 'nested/file.txt',
				content: 'hello\n',
				worktree: '.'
			});

			expect(result).toMatchObject({
				ok: true,
				result: { type: 'create', originalFile: null, filePath: join(workspace, 'nested/file.txt') }
			});
			expect(await readFile(join(workspace, 'nested', 'file.txt'), 'utf8')).toBe('hello\n');
			if (result.ok) {
				const output = result.result as { structuredPatch: unknown[] };
				expect(Array.isArray(output.structuredPatch)).toBe(true);
			}
		});
	});

	it('overwrites an existing file, reporting type update with the original content', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'file.txt');
			await writeFile(path, 'original\n');

			const result = await tool(workspace, 'write').handler({
				file_path: 'file.txt',
				content: 'replacement\n'
			});

			expect(result).toMatchObject({
				ok: true,
				result: { type: 'update', originalFile: 'original\n' }
			});
			expect(await readFile(path, 'utf8')).toBe('replacement\n');
		});
	});

	it('accepts an absolute file_path inside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'write').handler({
				file_path: join(workspace, 'abs.txt'),
				content: 'abs\n'
			});
			expect(result).toMatchObject({ ok: true, result: { type: 'create' } });
			expect(await readFile(join(workspace, 'abs.txt'), 'utf8')).toBe('abs\n');
		});
	});

	it('rejects a path outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'write').handler({
				file_path: join(tmpdir(), 'portal-write-escape', 'escape.txt'),
				content: 'nope'
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});

	it('renders the SDK-style confirmation for create and update', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'sample.txt'), 'original\n');
			const created = await tool(workspace, 'write').handler({
				file_path: 'new.txt',
				content: 'brand new\n'
			});
			expect(created).toMatchObject({ ok: true });
			if (created.ok) {
				const view = created.views?.find((v) => v.type === 'text');
				expect(view?.text).toBe(
					'File created successfully at: new.txt (file state is current in your context — no need to Read it back)'
				);
			}
			const updated = await tool(workspace, 'write').handler({
				file_path: 'sample.txt',
				content: 'completely replaced\n'
			});
			if (updated.ok) {
				const view = updated.views?.find((v) => v.type === 'text');
				expect(view?.text).toBe(
					'The file sample.txt has been updated successfully. (file state is current in your context — no need to Read it back)'
				);
			}
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
