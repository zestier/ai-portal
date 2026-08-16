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
import { makeTmpDir } from '../../helpers/tmp';
import { buildTrashTools } from '../../../src/lib/server/tools/filesystem';
import { scratchSubdir, scratchDir, zapDir } from '../../../src/lib/server/tools/zap-dir';
import type { PortalTool, ToolResult } from '../../../src/lib/server/tools/types';

const TRASH_DIR = scratchSubdir('trash');

function trashTool(root: string): PortalTool {
	const tool = buildTrashTools(root)[0];
	if (!tool) throw new Error('trash tool not registered');
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

describe('trash tool', () => {
	let root: string;
	let trash: PortalTool;

	beforeEach(() => {
		root = makeTmpDir('trash-');
		trash = trashTool(root);
	});

	function onlyTrashEntry(): string {
		const entries = readdirSync(join(root, TRASH_DIR));
		expect(entries).toHaveLength(1);
		return entries[0];
	}

	it('moves a file into the trash dir and removes it from its original location', async () => {
		writeFileSync(join(root, 'a.txt'), 'bye');
		const res = await trash.handler({ path: 'a.txt' });
		const payload = expectOk<{ originalPath: string; entryId: string; trashPath: string }>(res);
		expect(payload.originalPath).toBe('a.txt');
		expect(existsSync(join(root, 'a.txt'))).toBe(false);
		expect(readFileSync(join(root, payload.trashPath), 'utf-8')).toBe('bye');
		expect(payload.trashPath.startsWith(`${TRASH_DIR}/`)).toBe(true);
	});

	it('drops a self-contained .zap/.gitignore ignoring the scratch tree', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		await trash.handler({ path: 'a.txt' });
		const ignorePath = join(root, zapDir(), '.gitignore');
		expect(existsSync(ignorePath)).toBe(true);
		expect(readFileSync(ignorePath, 'utf-8')).toContain('/scratch/');
	});

	it('never clobbers a pre-existing .zap/.gitignore', async () => {
		mkdirSync(join(root, zapDir()), { recursive: true });
		writeFileSync(join(root, zapDir(), '.gitignore'), '# custom\n/scratch/\n');
		writeFileSync(join(root, 'a.txt'), 'x');
		await trash.handler({ path: 'a.txt' });
		expect(readFileSync(join(root, zapDir(), '.gitignore'), 'utf-8')).toBe('# custom\n/scratch/\n');
	});

	it('writes a restorable meta.json describing the original path', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		await trash.handler({ path: 'a.txt' });
		const entryId = onlyTrashEntry();
		const meta = JSON.parse(readFileSync(join(root, TRASH_DIR, entryId, 'meta.json'), 'utf-8'));
		expect(meta).toMatchObject({ originalPath: 'a.txt', name: 'a.txt', type: 'file' });
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
		expect(readdirSync(join(root, TRASH_DIR))).toHaveLength(2);
	});

	it('errors when the path does not exist', async () => {
		expect(expectErr(await trash.handler({ path: 'missing.txt' }))).toMatch(/does not exist/i);
	});

	it('refuses to trash the workspace root', async () => {
		expect(expectErr(await trash.handler({ path: '.' }))).toMatch(/workspace root/i);
	});

	it('refuses to trash the trash store itself', async () => {
		mkdirSync(join(root, TRASH_DIR), { recursive: true });
		expect(expectErr(await trash.handler({ path: TRASH_DIR }))).toMatch(/trash/i);
	});

	it('refuses to trash a path nested inside the trash store', async () => {
		mkdirSync(join(root, TRASH_DIR, 'old'), { recursive: true });
		writeFileSync(join(root, TRASH_DIR, 'old/x'), 'x');
		expect(expectErr(await trash.handler({ path: `${TRASH_DIR}/old/x` }))).toMatch(/trash/i);
	});

	it('refuses to trash an already-trashed entry reached through a symlinked .zap', async () => {
		mkdirSync(join(root, 'realzap/scratch/trash/old'), { recursive: true });
		writeFileSync(join(root, 'realzap/scratch/trash/old/x'), 'x');
		symlinkSync(join(root, 'realzap'), join(root, zapDir()));
		expect(expectErr(await trash.handler({ path: `${TRASH_DIR}/old/x` }))).toMatch(/trash/i);
		expect(existsSync(join(root, 'realzap/scratch/trash/old/x'))).toBe(true);
	});

	it('refuses to trash an ancestor of the trash store, leaving it intact', async () => {
		mkdirSync(join(root, TRASH_DIR), { recursive: true });
		for (const ancestor of [zapDir(), scratchDir()]) {
			expect(expectErr(await trash.handler({ path: ancestor }))).toMatch(
				/contains the trash store/i
			);
			expect(existsSync(join(root, ancestor))).toBe(true);
		}
	});

	it('rejects absolute paths without trashing anything', async () => {
		const outside = makeTmpDir('trash-outside-');
		writeFileSync(join(outside, 'secret'), 'x');
		expect(expectErr(await trash.handler({ path: join(outside, 'secret') }))).toMatch(/absolute/i);
		expect(existsSync(join(outside, 'secret'))).toBe(true);
	});

	it('rejects a `..` escape', async () => {
		expect(expectErr(await trash.handler({ path: '../escape' }))).toMatch(/escapes the workspace/i);
	});

	it('rejects an escape via a symlinked parent pointing outside the workspace', async () => {
		const outside = makeTmpDir('trash-symlink-');
		writeFileSync(join(outside, 'secret'), 'x');
		symlinkSync(outside, join(root, 'link'));
		expect(expectErr(await trash.handler({ path: 'link/secret' }))).toMatch(
			/escapes the workspace/i
		);
		expect(existsSync(join(outside, 'secret'))).toBe(true);
	});

	describe('derivePermissionRequest', () => {
		it('derives a write request on the resolved in-workspace path (delete ⊆ write)', () => {
			const req = trash.derivePermissionRequest?.({ path: 'a.txt' });
			expect(req).toEqual({ permissionKind: 'write', path: join(root, 'a.txt') });
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
