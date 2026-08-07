import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadFileTools } from './read-file';

let root: string;
let testFile: string;

beforeAll(() => {
	root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'files-test-'));
	testFile = join(root, 'test.txt');
	writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5');
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('read_file tool', () => {
	const readFileTool = () => buildReadFileTools(root)[0]!;
	const writeLongFile = () =>
		writeFileSync(
			join(root, 'long.txt'),
			Array.from({ length: 150 }, (_, i) => `line${i + 1}`).join('\n')
		);

	it('reads a file completely', async () => {
		const args = { path: 'test.txt' };
		const result = await readFileTool().handler(args);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			content: 'line1\nline2\nline3\nline4\nline5',
			startLine: 1,
			endLine: 5,
			totalLines: 5,
			isComplete: true
		});
	});

	it('defaults to the first 100 lines and reports omitted content', async () => {
		writeLongFile();
		const result = await readFileTool().handler({ path: 'long.txt' });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			startLine: 1,
			endLine: 100,
			totalLines: 150,
			isComplete: false
		});
		expect((result.result as { content: string }).content.split('\n')).toHaveLength(100);
	});

	it('caps a one-sided range at 100 lines', async () => {
		writeLongFile();
		const result = await readFileTool().handler({ path: 'long.txt', startLine: 26 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			startLine: 26,
			endLine: 125,
			totalLines: 150,
			isComplete: false
		});
	});

	it('returns the 100 lines ending at a lone end bound', async () => {
		writeLongFile();
		const result = await readFileTool().handler({ path: 'long.txt', endLine: 125 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			startLine: 26,
			endLine: 125,
			totalLines: 150,
			isComplete: false
		});
	});

	it('reads a specific line range', async () => {
		const args = { path: 'test.txt', startLine: 2, endLine: 4 };
		const result = await readFileTool().handler(args);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			content: 'line2\nline3\nline4',
			startLine: 2,
			endLine: 4,
			totalLines: 5,
			isComplete: false
		});
	});

	it('allows more than 100 lines when both bounds are explicit', async () => {
		writeLongFile();
		const result = await readFileTool().handler({ path: 'long.txt', startLine: 1, endLine: 150 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			startLine: 1,
			endLine: 150,
			totalLines: 150,
			isComplete: true
		});
		expect((result.result as { content: string }).content.split('\n')).toHaveLength(150);
	});

	it('rejects an inverted line range', async () => {
		const result = await readFileTool().handler({ path: 'test.txt', startLine: 4, endLine: 2 });
		expect(result).toMatchObject({ ok: false });
	});

	it('errors on missing file', async () => {
		const args = { path: 'nonexistent.txt' };
		const result = await readFileTool().handler(args);
		if (result.ok) throw new Error('expected missing file to fail');
		expect(result.error.message).toContain('does not exist');
	});

	it('errors on directory', async () => {
		const dirPath = join(root, 'subdir');
		mkdirSync(dirPath);
		const args = { path: 'subdir' };
		const result = await readFileTool().handler(args);
		if (result.ok) throw new Error('expected directory read to fail');
		expect(result.error.message).toContain('not a file');
	});

	it('errors on binary file', async () => {
		const binPath = join(root, 'bin.dat');
		writeFileSync(binPath, Buffer.from([0, 1, 2, 3]));
		const args = { path: 'bin.dat' };
		const result = await readFileTool().handler(args);
		if (result.ok) throw new Error('expected binary read to fail');
		expect(result.error.message).toContain('binary');
	});
});
