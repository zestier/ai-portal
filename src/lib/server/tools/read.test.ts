import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReadTools } from './read';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function readTool(root: string) {
	return buildReadTools(root)[0]!;
}

describe('read tool', () => {
	it('renders a bounded read as plain lines with the total-line footer', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'alpha\nbeta\ngamma');
		const result = await readTool(root).handler({ file_path: 'sample.txt', offset: 1, limit: 3 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toEqual({
			type: 'text',
			file: {
				filePath: 'sample.txt',
				content: 'alpha\nbeta\ngamma',
				numLines: 3,
				startLine: 1,
				totalLines: 3,
				size: 16
			}
		});
		expect(result.views).toEqual([
			{ type: 'text', text: 'alpha\nbeta\ngamma\n(file has 3 total lines)' }
		]);
	});

	it('counts the trailing empty line of a newline-terminated file', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'a\nb\n');
		const result = await readTool(root).handler({ file_path: 'sample.txt', offset: 1, limit: 5 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { numLines: 3, startLine: 1, totalLines: 3 }
		});
		expect(result.views).toEqual([{ type: 'text', text: 'a\nb\n\n(file has 3 total lines)' }]);
	});

	it('accepts an absolute file_path and honors offset/limit', async () => {
		const root = makeTmpDir('read-tool-');
		const abs = join(root, 'sample.txt');
		writeFileSync(abs, 'a\nb\nc\nd\ne');
		const result = await readTool(root).handler({ file_path: abs, offset: 2, limit: 2 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { numLines: 2, startLine: 2, totalLines: 5 }
		});
		expect(result.views).toEqual([{ type: 'text', text: 'b\nc\n(file has 5 total lines)' }]);
	});

	it('renders numbered lines when numbered: true', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'a\nb\nc');
		const result = await readTool(root).handler({
			file_path: 'sample.txt',
			offset: 1,
			limit: 3,
			numbered: true
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { content: 'a\nb\nc', numLines: 3, startLine: 1, totalLines: 3 }
		});
		expect(result.views).toEqual([
			{ type: 'text', text: '1\ta\n2\tb\n3\tc\n(file has 3 total lines)' }
		]);
	});

	it('errors on text reads missing offset or limit with the true line count', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'a\nb\nc');
		const expected = `Reads of text files require both offset and limit (file has 3 lines) — e.g. offset: 1, limit: 100 reads the first 100 lines.`;
		for (const args of [
			{ file_path: 'sample.txt' },
			{ file_path: 'sample.txt', offset: 2 },
			{ file_path: 'sample.txt', limit: 2 }
		]) {
			const result = await readTool(root).handler(args);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toBe(expected);
		}
	});

	it('paginates a huge page with the continuation banner', async () => {
		const root = makeTmpDir('read-tool-');
		// 50k eight-char lines: the plain rendering exceeds the 200KB page cap
		// (about 450KB), so the auto-pagination kicks in.
		writeFileSync(
			join(root, 'many.txt'),
			Array.from({ length: 50_000 }, () => 'xxxxxxxx').join('\n')
		);
		const result = await readTool(root).handler({
			file_path: 'many.txt',
			offset: 1,
			limit: 50_000
		});
		if (!result.ok) throw new Error(result.error.message);
		const view = result.views?.[0] as { type: 'text'; text: string } | undefined;
		expect(view?.type).toBe('text');
		expect(view?.text).toMatch(
			/^Read \d+ lines \(\d+% complete\)\.\.\. continue with offset=\d+\n/
		);
		expect(view?.text).toMatch(/\(file has 50000 total lines\)$/);
		expect(
			(result.result as { file: { truncatedByTokenCap?: boolean } }).file.truncatedByTokenCap
		).toBe(true);
	});

	it('errors on a missing file with the SDK message including the cwd', async () => {
		const root = makeTmpDir('read-tool-');
		const result = await readTool(root).handler({ file_path: 'nope.txt' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe(
			`File does not exist. Note: your current working directory is ${root}.`
		);
	});

	it('rejects a path that escapes the workspace', async () => {
		const root = makeTmpDir('read-tool-');
		const outside = makeTmpDir('read-outside-');
		writeFileSync(join(outside, 'secret.txt'), 'secret');
		const result = await readTool(root).handler({ file_path: join(outside, 'secret.txt') });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('escapes the workspace');
	});

	it('rejects a symlink that escapes the workspace', async () => {
		const root = makeTmpDir('read-tool-');
		const outside = makeTmpDir('read-outside-');
		writeFileSync(join(outside, 'secret.txt'), 'secret');
		try {
			symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
		} catch {
			return; // no symlink support on this platform
		}
		const result = await readTool(root).handler({ file_path: 'link.txt' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('escapes the workspace');
	});

	it('returns an image as an image view with the SDK image shape', async () => {
		const root = makeTmpDir('read-tool-');
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
		]);
		writeFileSync(join(root, 'pic.png'), png);
		const result = await readTool(root).handler({ file_path: 'pic.png' });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'image',
			file: { type: 'image/png', originalSize: png.length }
		});
		expect(result.views).toEqual([
			{ type: 'image', data: png.toString('base64'), mimeType: 'image/png', description: 'pic.png' }
		]);
	});

	it('rejects pages as unsupported', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'doc.pdf'), 'pdf');
		const result = await readTool(root).handler({ file_path: 'doc.pdf', pages: '1-5' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('pages');
	});

	it('errors on a directory', async () => {
		const root = makeTmpDir('read-tool-');
		mkdirSync(join(root, 'sub'));
		const result = await readTool(root).handler({ file_path: 'sub' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('directory');
	});

	it('returns an outline for a broad read of a large file', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 300; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'big.py'), lines.join('\n'));
		const result = await readTool(root).handler({ file_path: 'big.py', offset: 1, limit: 500 });
		if (!result.ok) throw new Error(result.error.message);
		const file = result.result as {
			file: { outlined: boolean; totalLines: number; content: string };
		};
		expect(file.file.outlined).toBe(true);
		expect(file.file.totalLines).toBe(603);
		expect(file.file.content).toContain('def g0():');
		expect(file.file.content).toContain('header (1-');
		expect(file.file.content).not.toContain('return 150'); // mid-file body not re-sent
	});

	it('keeps targeted ranges raw even in large files', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 300; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'big.py'), lines.join('\n'));
		const result = await readTool(root).handler({ file_path: 'big.py', offset: 1, limit: 3 });
		if (!result.ok) throw new Error(result.error.message);
		const file = result.result as { file: { outlined?: boolean; content: string } };
		expect(file.file.outlined).toBeUndefined();
		expect(file.file.content).toBe('def f():\n    return 1\n');
	});

	it('returns an outline for a medium file too (not size-gated to huge files)', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'med.py'), lines.join('\n'));
		const result = await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 });
		if (!result.ok) throw new Error(result.error.message);
		const file = result.result as { file: { outlined?: boolean; totalLines: number } };
		expect(file.file.outlined).toBe(true);
		expect(file.file.totalLines).toBe(50);
	});

	it('honors mode content and returns raw content even for a large file', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 300; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'big.py'), lines.join('\n'));
		const result = await readTool(root).handler({
			file_path: 'big.py',
			offset: 1,
			limit: 500,
			mode: 'content'
		});
		if (!result.ok) throw new Error(result.error.message);
		const file = result.result as { file: { outlined?: boolean; content: string } };
		expect(file.file.outlined).toBeUndefined();
		expect(file.file.content).toContain('return 150'); // raw body present
	});

	it('mode outline forces an outline even when auto would return raw', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'med.py'), lines.join('\n'));
		// limit 20 <= MAX_RANGE would be raw under auto
		const result = await readTool(root).handler({
			file_path: 'med.py',
			offset: 1,
			limit: 20,
			mode: 'outline'
		});
		if (!result.ok) throw new Error(result.error.message);
		expect((result.result as { file: { outlined?: boolean } }).file.outlined).toBe(true);
	});

	it('a broad re-read of an unchanged file returns a short unchanged marker', async () => {
		const root = makeTmpDir('read-tool-');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 25; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(join(root, 'med.py'), lines.join('\n'));
		const first = await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 });
		if (!first.ok) throw new Error(first.error.message);
		expect((first.result as { type: string }).type).toBe('text'); // outline on first read
		const second = await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 });
		if (!second.ok) throw new Error(second.error.message);
		expect((second.result as { type: string }).type).toBe('unchanged');
		expect((second.views?.[0] as { text: string }).text).toContain('unchanged');
	});

	it('a broad re-read after a change returns only the delta hunks', async () => {
		const root = makeTmpDir('read-tool-');
		const path = join(root, 'med.py');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 25; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(path, lines.join('\n'));
		await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 });
		// change line 2 (return 1 -> return 99)
		writeFileSync(path, lines.map((l, i) => (i === 1 ? '    return 99' : l)).join('\n'));
		const second = await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 });
		if (!second.ok) throw new Error(second.error.message);
		const body = second.result as { type: string; hunks: unknown[] };
		expect(body.type).toBe('delta');
		expect(body.hunks.length).toBeGreaterThan(0);
		const text = (second.views?.[0] as { text: string }).text;
		expect(text).toContain('return 99');
		expect(text).not.toContain('return 23'); // far-away content not re-sent
	});

	it('targeted range re-reads stay raw (not swallowed by the delta)', async () => {
		const root = makeTmpDir('read-tool-');
		const path = join(root, 'med.py');
		const lines: string[] = ['def f():', '    return 1', ''];
		for (let i = 0; i < 25; i++) lines.push(`def g${i}():`, `    return ${i}`);
		writeFileSync(path, lines.join('\n'));
		await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 100 }); // broad -> outline
		const drill = await readTool(root).handler({ file_path: 'med.py', offset: 1, limit: 3 }); // targeted
		if (!drill.ok) throw new Error(drill.error.message);
		const file = drill.result as { type: string; file: { content: string } };
		expect(file.type).toBe('text');
		expect(file.file.content).toBe('def f():\n    return 1\n');
	});
});
