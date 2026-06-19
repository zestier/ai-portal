import { describe, it, expect, beforeEach } from 'vitest';
import {
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	symlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from './helpers/tmp';
import { buildFilesystemTools } from '../src/lib/server/tools/filesystem';
import type { PortalTool, ToolResult } from '../src/lib/server/tools/types';

function getTool(root: string, name: string): PortalTool {
	const tool = buildFilesystemTools(root).find((t) => t.name === name);
	if (!tool) throw new Error(`${name} tool not registered`);
	return tool;
}

function expectErr(result: ToolResult): string {
	if (result.ok) throw new Error('expected error, got ok');
	return result.error.message;
}

function expectOk<T = unknown>(result: ToolResult): T {
	if (!result.ok) throw new Error(`expected ok, got error: ${result.error.message}`);
	return result.result as T;
}

describe('move tool', () => {
	let root: string;
	let move: PortalTool;

	beforeEach(() => {
		root = makeTmpDir('move-');
		move = getTool(root, 'move');
	});

	it('renames a file and reports workspace-relative paths', async () => {
		writeFileSync(join(root, 'a.txt'), 'hello');
		const res = await move.handler({ source: 'a.txt', destination: 'b.txt' });
		expect(expectOk(res)).toEqual({ source: 'a.txt', destination: 'b.txt', overwritten: false });
		expect(existsSync(join(root, 'a.txt'))).toBe(false);
		expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('hello');
	});

	it('creates missing destination parent directories', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		const res = await move.handler({ source: 'a.txt', destination: 'nested/deep/b.txt' });
		expect(res.ok).toBe(true);
		expect(existsSync(join(root, 'nested/deep/b.txt'))).toBe(true);
	});

	it('moves a directory', async () => {
		mkdirSync(join(root, 'src'));
		writeFileSync(join(root, 'src/f.txt'), 'x');
		const res = await move.handler({ source: 'src', destination: 'dst' });
		expect(res.ok).toBe(true);
		expect(existsSync(join(root, 'dst/f.txt'))).toBe(true);
		expect(existsSync(join(root, 'src'))).toBe(false);
	});

	it('refuses to overwrite an existing destination by default', async () => {
		writeFileSync(join(root, 'a.txt'), 'new');
		writeFileSync(join(root, 'b.txt'), 'old');
		const res = await move.handler({ source: 'a.txt', destination: 'b.txt' });
		expect(expectErr(res)).toMatch(/already exists/i);
		// Both files untouched.
		expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('new');
		expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('old');
	});

	it('overwrites an existing destination file when overwrite=true', async () => {
		writeFileSync(join(root, 'a.txt'), 'new');
		writeFileSync(join(root, 'b.txt'), 'old');
		const res = await move.handler({ source: 'a.txt', destination: 'b.txt', overwrite: true });
		expect(expectOk(res)).toMatchObject({ overwritten: true });
		expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('new');
	});

	it('never overwrites a directory, even with overwrite=true', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		mkdirSync(join(root, 'b'));
		const res = await move.handler({ source: 'a.txt', destination: 'b', overwrite: true });
		expect(expectErr(res)).toMatch(/existing directory/i);
		expect(existsSync(join(root, 'a.txt'))).toBe(true);
	});

	it('errors when the source does not exist', async () => {
		const res = await move.handler({ source: 'missing.txt', destination: 'b.txt' });
		expect(expectErr(res)).toMatch(/does not exist/i);
	});

	it('rejects an absolute source without moving anything', async () => {
		const outside = makeTmpDir('move-outside-');
		writeFileSync(join(outside, 'secret'), 'x');
		const res = await move.handler({ source: join(outside, 'secret'), destination: 'b.txt' });
		expect(expectErr(res)).toMatch(/source:.*absolute/i);
		expect(existsSync(join(root, 'b.txt'))).toBe(false);
	});

	it('rejects an absolute destination (escaping the workspace)', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		const outside = makeTmpDir('move-outside-dst-');
		const res = await move.handler({ source: 'a.txt', destination: join(outside, 'evil') });
		expect(expectErr(res)).toMatch(/destination:.*absolute/i);
		expect(existsSync(join(outside, 'evil'))).toBe(false);
		expect(existsSync(join(root, 'a.txt'))).toBe(true);
	});

	it('rejects a `..` destination escape', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		const res = await move.handler({ source: 'a.txt', destination: '../escape.txt' });
		expect(expectErr(res)).toMatch(/destination:.*escapes the workspace/i);
	});

	it('errors when source and destination are the same path', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		const res = await move.handler({ source: 'a.txt', destination: './a.txt' });
		expect(expectErr(res)).toMatch(/same path/i);
	});

	describe('derivePermissionRequest', () => {
		it('gates on BOTH paths (source as primary, destination as additional) when in-workspace', () => {
			const req = move.derivePermissionRequest?.({ source: 'a.txt', destination: 'sub/b.txt' });
			expect(req?.permissionKind).toBe('write');
			expect(req?.path).toBe(join(root, 'a.txt'));
			expect(req?.additionalPaths).toEqual([join(root, 'sub/b.txt')]);
		});

		it('surfaces an out-of-workspace SOURCE so the gateway evaluates it', () => {
			const outside = makeTmpDir('move-derive-src-');
			const req = move.derivePermissionRequest?.({
				source: join(outside, 'x'),
				destination: 'b.txt'
			});
			expect(req?.path).toBe(join(outside, 'x'));
			expect(req?.additionalPaths).toEqual([join(root, 'b.txt')]);
		});

		it('surfaces an out-of-workspace DESTINATION so the gateway evaluates it', () => {
			const outside = makeTmpDir('move-derive-dst-');
			const req = move.derivePermissionRequest?.({
				source: 'a.txt',
				destination: join(outside, 'x')
			});
			expect(req?.path).toBe(join(root, 'a.txt'));
			expect(req?.additionalPaths).toEqual([join(outside, 'x')]);
		});

		it('returns null for invalid args', () => {
			expect(move.derivePermissionRequest?.({ source: 'a.txt' })).toBeNull();
		});
	});
});

describe('trash tool', () => {
	let root: string;
	let trash: PortalTool;

	beforeEach(() => {
		root = makeTmpDir('trash-');
		trash = getTool(root, 'trash');
	});

	function onlyTrashEntry(): string {
		const entries = readdirSync(join(root, '.trash'));
		expect(entries).toHaveLength(1);
		return entries[0];
	}

	it('moves a file into .trash and removes it from its original location', async () => {
		writeFileSync(join(root, 'a.txt'), 'bye');
		const res = await trash.handler({ path: 'a.txt' });
		const payload = expectOk<{ originalPath: string; entryId: string; trashPath: string }>(res);
		expect(payload.originalPath).toBe('a.txt');
		expect(existsSync(join(root, 'a.txt'))).toBe(false);
		expect(readFileSync(join(root, payload.trashPath), 'utf-8')).toBe('bye');
	});

	it('writes a restorable meta.json describing the original path', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		await trash.handler({ path: 'a.txt' });
		const entryId = onlyTrashEntry();
		const meta = JSON.parse(readFileSync(join(root, '.trash', entryId, 'meta.json'), 'utf-8'));
		expect(meta.originalPath).toBe('a.txt');
		expect(meta.name).toBe('a.txt');
		expect(meta.type).toBe('file');
		expect(typeof meta.trashedAt).toBe('string');
	});

	it('trashes a directory', async () => {
		mkdirSync(join(root, 'dir'));
		writeFileSync(join(root, 'dir/f.txt'), 'x');
		const res = await trash.handler({ path: 'dir' });
		const payload = expectOk<{ trashPath: string }>(res);
		expect(existsSync(join(root, 'dir'))).toBe(false);
		expect(existsSync(join(root, payload.trashPath, 'f.txt'))).toBe(true);
	});

	it('preserves earlier entries when trashing a second item', async () => {
		writeFileSync(join(root, 'a.txt'), '1');
		writeFileSync(join(root, 'b.txt'), '2');
		await trash.handler({ path: 'a.txt' });
		await trash.handler({ path: 'b.txt' });
		expect(readdirSync(join(root, '.trash'))).toHaveLength(2);
	});

	it('errors when the path does not exist', async () => {
		const res = await trash.handler({ path: 'missing.txt' });
		expect(expectErr(res)).toMatch(/does not exist/i);
	});

	it('refuses to trash the workspace root', async () => {
		const res = await trash.handler({ path: '.' });
		expect(expectErr(res)).toMatch(/workspace root/i);
	});

	it('refuses to trash the .trash store itself', async () => {
		mkdirSync(join(root, '.trash'));
		const res = await trash.handler({ path: '.trash' });
		expect(expectErr(res)).toMatch(/\.trash/i);
	});

	it('refuses to trash a path nested inside .trash', async () => {
		mkdirSync(join(root, '.trash', 'old'), { recursive: true });
		writeFileSync(join(root, '.trash/old/x'), 'x');
		const res = await trash.handler({ path: '.trash/old/x' });
		expect(expectErr(res)).toMatch(/\.trash/i);
	});

	it('rejects absolute paths without trashing anything', async () => {
		const outside = makeTmpDir('trash-outside-');
		writeFileSync(join(outside, 'secret'), 'x');
		const res = await trash.handler({ path: join(outside, 'secret') });
		expect(expectErr(res)).toMatch(/absolute/i);
		expect(existsSync(join(outside, 'secret'))).toBe(true);
	});

	it('rejects a `..` escape', async () => {
		const res = await trash.handler({ path: '../escape' });
		expect(expectErr(res)).toMatch(/escapes the workspace/i);
	});

	it('rejects an escape via a symlinked parent pointing outside the workspace', async () => {
		const outside = makeTmpDir('trash-symlink-');
		writeFileSync(join(outside, 'secret'), 'x');
		symlinkSync(outside, join(root, 'link'));
		const res = await trash.handler({ path: 'link/secret' });
		expect(expectErr(res)).toMatch(/escapes the workspace/i);
		expect(existsSync(join(outside, 'secret'))).toBe(true);
	});

	describe('derivePermissionRequest', () => {
		it('derives a write request on the resolved in-workspace path (delete ⊆ write)', () => {
			const req = trash.derivePermissionRequest?.({ path: 'a.txt' });
			expect(req?.permissionKind).toBe('write');
			expect(req?.path).toBe(join(root, 'a.txt'));
		});

		it('derives a write request on an out-of-workspace path so it prompts', () => {
			const outside = makeTmpDir('trash-derive-outside-');
			const req = trash.derivePermissionRequest?.({ path: join(outside, 'x') });
			expect(req?.path).toBe(join(outside, 'x'));
		});

		it('returns null for invalid args', () => {
			expect(trash.derivePermissionRequest?.({})).toBeNull();
		});
	});
});
