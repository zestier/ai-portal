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

	it('reads a file completely', async () => {
		const args = { path: 'test.txt' };
		const result = await readFileTool().handler(args);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({ content: 'line1\nline2\nline3\nline4\nline5' });
	});

	it('reads a specific line range', async () => {
		const args = { path: 'test.txt', startLine: 2, endLine: 4 };
		const result = await readFileTool().handler(args);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({ content: 'line2\nline3\nline4' });
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
