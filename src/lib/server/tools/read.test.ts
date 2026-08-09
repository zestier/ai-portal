import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReadTools } from './read';
import { renderReadModelText } from './read';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function readTool(root: string) {
	return buildReadTools(root)[0]!;
}

describe('read tool', () => {
	it('renders a whole-file read as numbered lines with the SDK text shape', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'alpha\nbeta\ngamma');
		const result = await readTool(root).handler({ file_path: 'sample.txt' });
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
		expect(result.views).toEqual([{ type: 'text', text: '1\talpha\n2\tbeta\n3\tgamma' }]);
	});

	it('counts the trailing empty line of a newline-terminated file (golden small)', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'a\nb\n');
		const result = await readTool(root).handler({ file_path: 'sample.txt' });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { numLines: 3, startLine: 1, totalLines: 3 }
		});
		expect(result.views).toEqual([{ type: 'text', text: '1\ta\n2\tb\n3\t' }]);
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
		expect(result.views).toEqual([{ type: 'text', text: '2\tb\n3\tc' }]);
	});

	it('errors on a whole-file read past the 256KB cap with the SDK message', async () => {
		const root = makeTmpDir('read-tool-');
		const size = 256 * 1024 + 1;
		writeFileSync(join(root, 'big.txt'), Buffer.alloc(size, 0x61));
		const result = await readTool(root).handler({ file_path: 'big.txt' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// 256KB + 1 = 256.001KB -> the SDK formats KiB labeled as KB.
		expect(result.error.message).toBe(
			`File content (256.0KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`
		);
	});

	it('paginates a huge page with the continuation banner', async () => {
		const root = makeTmpDir('read-tool-');
		// 50k single-char lines: the file itself is 100KB (under the 256KB
		// whole-read cap) but the numbered rendering exceeds the 200KB page cap,
		// so the SDK-style auto-pagination kicks in.
		writeFileSync(join(root, 'many.txt'), Array.from({ length: 50_000 }, () => 'x').join('\n'));
		const result = await readTool(root).handler({ file_path: 'many.txt' });
		if (!result.ok) throw new Error(result.error.message);
		const view = result.views?.[0] as { type: 'text'; text: string } | undefined;
		expect(view?.type).toBe('text');
		expect(view?.text).toMatch(
			/^Read \d+ lines \(\d+% complete\)\.\.\. continue with offset=\d+\n/
		);
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

	it('renderReadModelText matches the numbered model text (golden replay)', async () => {
		const root = makeTmpDir('read-tool-');
		writeFileSync(join(root, 'sample.txt'), 'alpha one\nbeta two\ngamma three');
		await expect(renderReadModelText({ file_path: 'sample.txt' }, root)).resolves.toBe(
			'1\talpha one\n2\tbeta two\n3\tgamma three'
		);
		await expect(
			renderReadModelText({ file_path: 'sample.txt', offset: 2, limit: 1 }, root)
		).resolves.toBe('2\tbeta two');
	});
});
