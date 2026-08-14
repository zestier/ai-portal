import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildEditFileTools,
	cappedLevenshtein,
	collapseWhitespace,
	findClosestMatch,
	MAX_SUGGEST_DISTANCE,
	MAX_SUGGEST_FILE_BYTES,
	MAX_SUGGEST_LINES,
	MAX_SUGGEST_OLD_BYTES
} from '../src/lib/server/tools/edit-file';

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

// A reference (uncapped, O(n·m)) Levenshtein over code-point arrays, used to
// cross-check `cappedLevenshtein`'s banded implementation.
function referenceLevenshtein(a: string[], b: string[]): number {
	let prev = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		const cur = new Array<number>(b.length + 1);
		cur[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = cur;
	}
	return prev[b.length];
}

describe('collapseWhitespace', () => {
	it('collapses internal space/tab runs and normalizes CRLF to LF', () => {
		expect(collapseWhitespace('gamma  three')).toBe('gamma three');
		expect(collapseWhitespace('a\t\tb')).toBe('a b');
		expect(collapseWhitespace('a \t b')).toBe('a b');
		expect(collapseWhitespace('a\r\nb')).toBe('a\nb');
		// Newlines are preserved (they anchor line structure).
		expect(collapseWhitespace('gamma  three\nbeta   two')).toBe('gamma three\nbeta two');
	});
});

describe('cappedLevenshtein', () => {
	it('matches the reference DP exactly when within the cap', () => {
		const cases: Array<[string, string]> = [
			['', ''],
			['a', ''],
			['', 'a'],
			['gamma tree', 'gamma three'],
			['kitten', 'sitting'],
			['flaw', 'lawn'],
			['a', 'a'],
			['abc', 'abc'],
			['abc', 'xyz'],
			['a b', 'ab'],
			['a\nb', 'a\nb']
		];
		for (const [x, y] of cases) {
			const ax = Array.from(x);
			const ay = Array.from(y);
			const expected = referenceLevenshtein(ax, ay);
			expect(cappedLevenshtein(ax, ay, MAX_SUGGEST_DISTANCE)).toBe(expected);
		}
	});

	it('returns the sentinel (maxDist + 1) when the true distance exceeds the cap', () => {
		expect(cappedLevenshtein(Array.from('abc'), Array.from('xyz'), 1)).toBe(2);
		expect(cappedLevenshtein(Array.from('kitten'), Array.from('sitting'), 2)).toBe(3);
	});

	it('matches the reference DP on random strings within a tight cap', () => {
		const alphabet = 'abc '; // small alphabet → realistic distances
		for (let trial = 0; trial < 200; trial++) {
			const lenA = 1 + ((trial * 7) % 10);
			const lenB = 1 + ((trial * 5) % 10);
			const a = Array.from({ length: lenA }, () => alphabet[(trial + lenA) % 4]!);
			const b = Array.from({ length: lenB }, () => alphabet[(trial * 2 + lenB) % 4]!);
			const expected = referenceLevenshtein(a, b);
			// Cap near the true distance to exercise both the in-cap and
			// over-cap branches against the reference.
			for (const cap of [0, 1, 2, 3, 4, 5, 8]) {
				const got = cappedLevenshtein(a, b, cap);
				expect(got).toBe(expected <= cap ? expected : cap + 1);
			}
		}
	});
});

describe('findClosestMatch', () => {
	it('finds a one-word typo on a single line with 1-based line numbers', () => {
		const match = findClosestMatch('alpha one\ngamma three\nbeta two\n', 'gamma tree');
		expect(match).not.toBeNull();
		expect(match).toMatchObject({ snippet: 'gamma three', lineStart: 2, lineEnd: 2 });
		expect(match!.similarity).toBeGreaterThan(0.6);
	});

	it('selects the correct multi-line window for a multi-line old_string', () => {
		const match = findClosestMatch(
			'alpha one\ngamma three\nbeta two\ndelta four\n',
			'gamma tree\nbeta two'
		);
		expect(match).not.toBeNull();
		expect(match).toMatchObject({
			snippet: 'gamma three\nbeta two',
			lineStart: 2,
			lineEnd: 3
		});
	});

	it('returns null when nothing clears the similarity threshold', () => {
		expect(findClosestMatch('unchanged\n', 'does not exist anywhere')).toBeNull();
		// Fewer file lines than old_string lines → no windows at all.
		expect(findClosestMatch('one line\n', 'alpha one\nbeta two')).toBeNull();
	});

	it('scores whitespace-only differences as a perfect match', () => {
		const match = findClosestMatch('gamma three\n', 'gamma  three');
		expect(match).not.toBeNull();
		expect(match).toMatchObject({ snippet: 'gamma three', lineStart: 1, lineEnd: 1 });
		expect(match!.similarity).toBe(1);
	});

	it('scores CRLF content equal to LF content', () => {
		const match = findClosestMatch('gamma three\r\nbeta two\r\n', 'gamma tree\nbeta two');
		expect(match).not.toBeNull();
		expect(match).toMatchObject({ snippet: 'gamma three\nbeta two', lineStart: 1, lineEnd: 2 });
	});

	it('caps the snippet at MAX_SUGGEST_LINES trimmed lines', () => {
		const block = ['alpha one', 'beta two', 'gamma three', 'delta four', 'epsilon five'].join('\n');
		const match = findClosestMatch(
			block + '\n',
			'alpha one\nbeta too\ngamma three\ndelta four\nepsilon five'
		);
		expect(match).not.toBeNull();
		expect(match).toMatchObject({ lineStart: 1, lineEnd: 5 });
		expect(match!.snippet.split('\n').length).toBeLessThanOrEqual(MAX_SUGGEST_LINES);
	});

	it('returns null for files over the file size guard', () => {
		expect(
			findClosestMatch('x'.repeat(MAX_SUGGEST_FILE_BYTES + 1) + '\n', 'gamma tree')
		).toBeNull();
	});

	it('returns null for old_string over the old_string size guard', () => {
		expect(
			findClosestMatch('gamma three\n', 'gamma ' + 'x'.repeat(MAX_SUGGEST_OLD_BYTES + 1))
		).toBeNull();
	});

	it('returns null for an empty or all-whitespace old_string', () => {
		expect(findClosestMatch('gamma three\n', '')).toBeNull();
		expect(findClosestMatch('gamma three\n', '   \t  ')).toBeNull();
	});
});

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
			// ACB-3: low-similarity not-found carries EXACTLY today's envelope —
			// no hint, no code, no suggestion metadata.
			if (!result.ok) {
				expect(result.error.details).toBeUndefined();
				expect(result.error.code).toBeUndefined();
				expect(result.error.message).not.toContain('Did you mean:');
			}
			expect(await readFile(path, 'utf8')).toBe('unchanged\n');
		});
	});

	it('suggests the closest matching region for a one-word typo (ACB-1)', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'alpha one\ngamma three\nbeta two\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'gamma tree',
				new_string: 'gamma FOUR'
			});

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error.message).toContain('Did you mean:');
				expect(result.error.message).toContain('line 2: gamma three');
				expect(result.error.details).toMatchObject({
					suggestion: { snippet: 'gamma three', lineStart: 2, lineEnd: 2 }
				});
				const suggestion = (result.error.details as { suggestion: { similarity: number } })
					.suggestion;
				expect(suggestion.similarity).toBeGreaterThan(0.6);
			}
			expect(await readFile(path, 'utf8')).toBe('alpha one\ngamma three\nbeta two\n');
		});
	});

	it('selects the correct multi-line window for a multi-line old_string (ACB-2)', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'alpha one\ngamma three\nbeta two\ndelta four\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'gamma tree\nbeta two',
				new_string: 'x'
			});

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error.message).toContain('Did you mean:');
				expect(result.error.details).toMatchObject({
					suggestion: { snippet: 'gamma three\nbeta two', lineStart: 2, lineEnd: 3 }
				});
			}
			expect(await readFile(path, 'utf8')).toBe('alpha one\ngamma three\nbeta two\ndelta four\n');
		});
	});

	it('surfaces a hint for whitespace-only differences (ACB-7)', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			await writeFile(path, 'gamma three\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'gamma  three',
				new_string: 'x'
			});

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error.message).toContain('Did you mean:');
				expect(result.error.message).toContain('line 1: gamma three');
				expect(result.error.details).toMatchObject({
					suggestion: { similarity: 1, lineStart: 1, lineEnd: 1 }
				});
			}
		});
	});

	it('skips the suggestion search for files over the size guard (ACB-5)', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'big.txt');
			await writeFile(path, 'a'.repeat(512 * 1024 + 1) + '\ngamma three\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'big.txt',
				old_string: 'gamma tree',
				new_string: 'x'
			});

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error.message).not.toContain('Did you mean:');
				expect(result.error.details).toBeUndefined();
				expect(result.error.message).toBe(
					'<tool_use_error>String to replace not found in file.\nString: gamma tree</tool_use_error>'
				);
			}
		});
	});

	it('keeps the hint concise (at most MAX_SUGGEST_LINES lines, ACB-8)', async () => {
		await withWorkspace(async (workspace) => {
			const path = join(workspace, 'sample.txt');
			const block = ['alpha one', 'beta two', 'gamma three', 'delta four', 'epsilon five'].join(
				'\n'
			);
			await writeFile(path, block + '\n');

			const result = await tool(workspace, 'edit').handler({
				file_path: 'sample.txt',
				old_string: 'alpha one\nbeta too\ngamma three\ndelta four\nepsilon five',
				new_string: 'x'
			});

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				const suggestion = (
					result.error.details as {
						suggestion: { snippet: string; lineStart: number; lineEnd: number };
					}
				).suggestion;
				expect(suggestion.lineStart).toBe(1);
				expect(suggestion.lineEnd).toBe(5);
				expect(suggestion.snippet.split('\n').length).toBeLessThanOrEqual(MAX_SUGGEST_LINES);
				// No full-file dump: the 4th/5th window lines are not in the hint.
				expect(suggestion.snippet).not.toContain('delta four');
				expect(suggestion.snippet).not.toContain('epsilon five');
			}
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
