import { describe, it, expect } from 'vitest';
import { parseApplyPatch } from '../src/lib/client/apply-patch';

describe('parseApplyPatch', () => {
	it('returns null for input that is not unified diff format', () => {
		expect(parseApplyPatch('just some text')).toBeNull();
		expect(
			parseApplyPatch('*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch')
		).toBeNull();
	});

	it('parses updates, additions, and deletions from a multi-file Git diff', () => {
		const input = [
			'diff --git a/src/foo.ts b/src/foo.ts',
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -1 +1 @@',
			'-const value = 1;',
			'+const value = 2;',
			'diff --git a/src/bar.ts b/src/bar.ts',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/src/bar.ts',
			'@@ -0,0 +1 @@',
			'+export const bar = true;',
			'diff --git a/old.txt b/old.txt',
			'deleted file mode 100644',
			'--- a/old.txt',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-old'
		].join('\n');
		const changes = parseApplyPatch(input);

		expect(changes).toHaveLength(3);
		expect(changes?.map(({ kind, path }) => ({ kind, path }))).toEqual([
			{ kind: 'update', path: 'src/foo.ts' },
			{ kind: 'add', path: 'src/bar.ts' },
			{ kind: 'delete', path: 'old.txt' }
		]);
	});

	it('parses a bare unified diff without Git metadata', () => {
		const input = ['--- a/hello.txt', '+++ b/hello.txt', '@@ -1 +1 @@', '-hello', '+goodbye'].join(
			'\n'
		);

		expect(parseApplyPatch(input)?.[0]).toMatchObject({
			kind: 'update',
			path: 'hello.txt',
			oldPath: 'hello.txt',
			newPath: 'hello.txt'
		});
	});

	it('parses a rename-only Git diff', () => {
		const input = [
			'diff --git a/old.txt b/new.txt',
			'similarity index 100%',
			'rename from old.txt',
			'rename to new.txt'
		].join('\n');

		expect(parseApplyPatch(input)?.[0]).toMatchObject({
			kind: 'update',
			path: 'old.txt -> new.txt',
			oldPath: 'old.txt',
			newPath: 'new.txt'
		});
	});

	it('returns [] for a recognized diff with a malformed hunk header', () => {
		const input = ['--- a/a.txt', '+++ b/a.txt', '@@ broken', '-old', '+new'].join('\n');
		expect(parseApplyPatch(input)).toEqual([]);
	});

	it('returns [] for incomplete rename metadata', () => {
		const input = ['diff --git a/old.txt b/new.txt', 'rename from old.txt'].join('\n');
		expect(parseApplyPatch(input)).toEqual([]);
	});
});
