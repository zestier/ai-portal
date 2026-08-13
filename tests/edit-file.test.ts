import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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

function tool(workspace: string, name: 'edit' | 'write') {
	return buildEditFileTools(workspace).find((candidate) => candidate.name === name)!;
}

function initGitRepo(dir: string) {
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	execFileSync('git', ['config', 'user.name', 'Portal Test'], { cwd: dir });
	execFileSync('git', ['config', 'user.email', 'portal-test@localhost'], { cwd: dir });
	execFileSync('git', ['add', '-A'], { cwd: dir });
	execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
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

describe('edit', () => {
	it('replaces the first occurrence by default, reporting the SDK FileEditOutput shape', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'gamma three\nbeta two\ngamma three\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'gamma three',
				new_string: 'gamma THREE'
			});

			expect(result).toMatchObject({
				ok: true,
				result: {
					filePath: path,
					oldString: 'gamma three',
					newString: 'gamma THREE',
					originalFile: 'gamma three\nbeta two\ngamma three\n',
					userModified: false,
					replaceAll: false
				}
			});
			expect(await readFile(path, 'utf8')).toBe('gamma THREE\nbeta two\ngamma three\n');
			if (result.ok) {
				const output = result.result as { structuredPatch: unknown[] };
				expect(Array.isArray(output.structuredPatch)).toBe(true);
			}
		});
	});

	it('renders the SDK confirmation for a single replacement', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'sample.txt'), 'gamma three\n');
			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'gamma three',
				new_string: 'gamma THREE'
			});
			expect(result).toMatchObject({ ok: true });
			if (result.ok) {
				const view = result.views?.find((v) => v.type === 'text');
				expect(view?.text).toBe(
					'The file sample.txt has been updated successfully. (file state is current in your context — no need to Read it back)'
				);
			}
		});
	});

	it('replace_all replaces every occurrence with the SDK all-occurrences confirmation', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'twenty\nphi twenty one\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'twenty',
				new_string: 'TWENTY',
				replace_all: true
			});

			expect(result).toMatchObject({ ok: true, result: { replaceAll: true } });
			expect(await readFile(path, 'utf8')).toBe('TWENTY\nphi TWENTY one\n');
			if (result.ok) {
				const view = result.views?.find((v) => v.type === 'text');
				expect(view?.text).toBe(
					'The file sample.txt has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)'
				);
			}
		});
	});

	it('fails with the SDK error text when old_string is absent, leaving the file unchanged', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'unchanged\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'does not exist anywhere',
				new_string: 'nope'
			});

			expect(result).toMatchObject({
				ok: false,
				error: {
					message:
						'<tool_use_error>String to replace not found in file.\nString: does not exist anywhere</tool_use_error>'
				}
			});
			expect(await readFile(path, 'utf8')).toBe('unchanged\n');
		});
	});

	it('accepts an absolute file_path inside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'abs.txt'), 'before\n');
			const result = await tool(workspace, 'edit').handler({
				file_path: join(workspace, 'abs.txt'),
				old_string: 'before',
				new_string: 'after'
			});
			expect(result).toMatchObject({ ok: true });
			expect(await readFile(join(workspace, 'abs.txt'), 'utf8')).toBe('after\n');
		});
	});

	it('rejects a path outside the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await tool(workspace, 'edit').handler({
				file_path: join(tmpdir(), 'portal-edit-escape', 'escape.txt'),
				old_string: 'x',
				new_string: 'y'
			});
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
		});
	});

	it('reports a gitDiff with status modified when the target is in a git repo', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'app.ts'), 'return value;\n');
			initGitRepo(workspace);

			const result = await tool(workspace, 'edit').handler({
				file_path: 'app.ts',
				old_string: 'return value;',
				new_string: 'return value.toUpperCase();'
			});

			expect(result).toMatchObject({ ok: true });
			if (result.ok) {
				const gitDiff = (result.result as { gitDiff?: { status: string } }).gitDiff;
				expect(gitDiff).toBeDefined();
				expect(gitDiff).toMatchObject({ filename: 'app.ts', status: 'modified' });
			}
		});
	});

	it('derives an edit-kind permission request for the target path', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'file.txt'), 'old\n');
			const derive = tool(workspace, 'edit').derivePermissionRequest;
			expect(derive).toBeDefined();
			expect(
				derive?.({ file_path: join(workspace, 'file.txt'), old_string: 'old', new_string: 'new' })
			).toEqual({ permissionKind: 'edit', path: join(workspace, 'file.txt') });
			// Out-of-workspace absolute paths still derive a request — the
			// permission gateway denies it against the user's grants — mirroring
			// the `write` tool. Unresolvable paths fall back to the custom-tool
			// request (null).
			expect(
				derive?.({ file_path: '/not/in/workspace.txt', old_string: 'a', new_string: 'b' })
			).toEqual({
				permissionKind: 'edit',
				path: '/not/in/workspace.txt'
			});
			expect(derive?.({ file_path: 'bad\0path', old_string: 'a', new_string: 'b' })).toBeNull();
		});
	});
});
