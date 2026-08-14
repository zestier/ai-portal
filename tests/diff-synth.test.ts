import { describe, it, expect } from 'vitest';
import {
	splitUnifiedDiffByFile,
	synthesizeDiff,
	synthesizeDiffs
} from '../src/lib/client/diff-synth';
import { parseUnifiedDiff, diffStats } from '../src/lib/client/diff-parser';

describe('synthesizeDiff', () => {
	it('handles the removed replace_text shape via the tolerant fallback', () => {
		// `replace_text` is gone from the tool set and from EDIT_TOOLS, but the
		// shape-based fallback still renders old turns that used it.
		const replacement = synthesizeDiff({
			tool: 'replace_text',
			argsJson: JSON.stringify({ path: 'src/a.ts', oldText: 'old', newText: 'new' })
		});
		expect(replacement?.path).toBe('src/a.ts');
		expect(replacement?.diff).toContain('-old');
		expect(replacement?.diff).toContain('+new');
	});

	it('synthesizes a diff for edit-style {old_str, new_str} args', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({
				path: 'src/foo.ts',
				old_str: 'const x = 1;\nconst y = 2;',
				new_str: 'const x = 10;\nconst y = 20;'
			})
		});
		expect(r).not.toBeNull();
		expect(r!.path).toBe('src/foo.ts');
		const stats = diffStats(parseUnifiedDiff(r!.diff));
		expect(stats.added).toBe(2);
		expect(stats.removed).toBe(2);
	});

	it('synthesizes a diff for create-style {file_text} args', () => {
		const r = synthesizeDiff({
			tool: 'create',
			argsJson: JSON.stringify({
				path: 'new.txt',
				file_text: 'hello\nworld\n'
			})
		});
		expect(r).not.toBeNull();
		const parsed = parseUnifiedDiff(r!.diff);
		const stats = diffStats(parsed);
		expect(stats.added).toBe(2);
		expect(stats.removed).toBe(0);
	});

	it('returns null when no path is present', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({ old_str: 'a', new_str: 'b' })
		});
		expect(r).toBeNull();
	});

	it('returns null for non-mutation tools when args do not match a known shape', () => {
		const r = synthesizeDiff({
			tool: 'bash',
			argsJson: JSON.stringify({ command: 'ls -la' })
		});
		expect(r).toBeNull();
	});

	it('handles the removed write_file alias via the tolerant fallback', () => {
		const r = synthesizeDiff({
			tool: 'write_file',
			argsJson: JSON.stringify({ filename: 'a.md', content: 'hi' })
		});
		expect(r).not.toBeNull();
		expect(r!.path).toBe('a.md');
	});

	it('preserves unchanged lines as context (LCS-based, not whole-block replacement)', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({
				path: 'f.ts',
				old_str: 'line1\nline2\nline3\nline4',
				new_str: 'line1\nLINE2\nline3\nline4'
			})
		});
		expect(r).not.toBeNull();
		const parsed = parseUnifiedDiff(r!.diff);
		const stats = diffStats(parsed);
		// Only line2 changed; the other three lines must be context, not
		// re-emitted as add/del.
		expect(stats.added).toBe(1);
		expect(stats.removed).toBe(1);
		expect(parsed.filter((l) => l.kind === 'context').length).toBe(3);
	});

	it('returns null on malformed JSON', () => {
		expect(synthesizeDiff({ tool: 'edit', argsJson: 'not json' })).toBeNull();
	});

	it('synthesizes one diff per edit from a multi_edit edits array', () => {
		const r = synthesizeDiffs({
			tool: 'multi_edit',
			argsJson: JSON.stringify({
				edits: [
					{
						file_path: 'src/foo.ts',
						old_string: 'const value = 1;',
						new_string: 'const value = 2;'
					},
					{ file_path: 'src/bar.ts', old_string: 'bar = false', new_string: 'bar = true' }
				]
			})
		});
		expect(r).toHaveLength(2);
		expect(r[0]?.path).toBe('src/foo.ts');
		expect(diffStats(parseUnifiedDiff(r[0]!.diff))).toEqual({ added: 1, removed: 1 });
		expect(r[1]?.path).toBe('src/bar.ts');
		expect(diffStats(parseUnifiedDiff(r[1]!.diff))).toEqual({ added: 1, removed: 1 });
	});

	it('synthesizes a separate diff for each sequential edit to the same file', () => {
		const r = synthesizeDiffs({
			tool: 'multi_edit',
			argsJson: JSON.stringify({
				edits: [
					{ file_path: 'f.ts', old_string: 'a', new_string: 'A' },
					{ file_path: 'f.ts', old_string: 'b', new_string: 'B' }
				]
			})
		});
		expect(r).toHaveLength(2);
		expect(r[0]?.path).toBe('f.ts');
		expect(r[1]?.path).toBe('f.ts');
	});

	it('returns no diffs for a multi_edit call without an edits array', () => {
		expect(synthesizeDiffs({ tool: 'multi_edit', argsJson: '{}' })).toEqual([]);
		expect(synthesizeDiffs({ tool: 'multi_edit', argsJson: null })).toEqual([]);
	});
});

describe('splitUnifiedDiffByFile', () => {
	it('splits a multi-file git diff into DiffView-ready chunks', () => {
		const diff = [
			'diff --git a/a.txt b/a.txt',
			'index 1..2 100644',
			'--- a/a.txt',
			'+++ b/a.txt',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'diff --git a/src/old.ts b/src/new.ts',
			'similarity index 88%',
			'rename from src/old.ts',
			'rename to src/new.ts',
			'--- a/src/old.ts',
			'+++ b/src/new.ts',
			'@@ -1 +1 @@',
			'-x',
			'+y'
		].join('\n');

		const chunks = splitUnifiedDiffByFile(diff);

		expect(chunks).toHaveLength(2);
		expect(chunks[0].path).toBe('a.txt');
		expect(chunks[0].diff).toContain('@@ -1 +1 @@');
		expect(chunks[1].path).toBe('src/old.ts -> src/new.ts');
		expect(chunks[1].diff).toContain('rename from src/old.ts');
	});

	it('returns no chunks for non-diff text', () => {
		expect(splitUnifiedDiffByFile('(no diff)')).toEqual([]);
	});
});
