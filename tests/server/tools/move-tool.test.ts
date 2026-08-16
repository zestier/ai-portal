import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from '../../helpers/tmp';
import { buildMoveTools } from '../../../src/lib/server/tools/filesystem';
import type { PortalTool, ToolResult } from '../../../src/lib/server/tools/types';

function moveTool(root: string): PortalTool {
	const tool = buildMoveTools(root)[0];
	if (!tool) throw new Error('move tool not registered');
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
		move = moveTool(root);
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
		expect(expectErr(await move.handler({ source: 'missing.txt', destination: 'b.txt' }))).toMatch(
			/does not exist/i
		);
	});

	it('rejects absolute source and destination paths', async () => {
		const outside = makeTmpDir('move-outside-');
		writeFileSync(join(outside, 'secret'), 'x');
		expect(
			expectErr(await move.handler({ source: join(outside, 'secret'), destination: 'b.txt' }))
		).toMatch(/source:.*absolute/i);
		writeFileSync(join(root, 'a.txt'), 'x');
		expect(
			expectErr(await move.handler({ source: 'a.txt', destination: join(outside, 'evil') }))
		).toMatch(/destination:.*absolute/i);
		expect(existsSync(join(root, 'a.txt'))).toBe(true);
	});

	it('rejects a `..` destination escape', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		expect(
			expectErr(await move.handler({ source: 'a.txt', destination: '../escape.txt' }))
		).toMatch(/destination:.*escapes the workspace/i);
	});

	it('errors when source and destination are the same path', async () => {
		writeFileSync(join(root, 'a.txt'), 'x');
		expect(expectErr(await move.handler({ source: 'a.txt', destination: './a.txt' }))).toMatch(
			/same path/i
		);
	});

	describe('derivePermissionRequest', () => {
		it('gates on BOTH paths when in-workspace', () => {
			const req = move.derivePermissionRequest?.({ source: 'a.txt', destination: 'sub/b.txt' });
			expect(req).toEqual({
				permissionKind: 'write',
				path: join(root, 'a.txt'),
				additionalPaths: [join(root, 'sub/b.txt')]
			});
		});

		it('surfaces out-of-workspace endpoints so the gateway evaluates them', () => {
			const outside = makeTmpDir('move-derive-');
			const sourceReq = move.derivePermissionRequest?.({
				source: join(outside, 'x'),
				destination: 'b.txt'
			});
			expect(sourceReq?.path).toBe(join(outside, 'x'));
			expect(sourceReq?.additionalPaths).toEqual([join(root, 'b.txt')]);

			const destinationReq = move.derivePermissionRequest?.({
				source: 'a.txt',
				destination: join(outside, 'x')
			});
			expect(destinationReq?.path).toBe(join(root, 'a.txt'));
			expect(destinationReq?.additionalPaths).toEqual([join(outside, 'x')]);
		});

		it('returns null for invalid args', () => {
			expect(move.derivePermissionRequest?.({ source: 'a.txt' })).toBeNull();
		});
	});
});
