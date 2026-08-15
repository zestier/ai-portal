import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyRangeEdit, buildEditFileTools } from './edit-file';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function editTool(root: string) {
	return buildEditFileTools(root).find((t) => t.name === 'edit')!;
}

describe('applyRangeEdit', () => {
	it('replaces a range and reports the applied range + line shift', () => {
		const out = applyRangeEdit('a\nb\nc\nd\ne', 2, 3, 'b', 'x\ny\nz');
		if (!out.ok) throw new Error(out.message);
		expect(out.content).toBe('a\nx\ny\nz\nd\ne');
		expect(out.applied_range).toEqual({ start: 2, end: 4 });
		expect(out.shift).toEqual({ after: 3, by: 1 });
		expect(out.old_lines).toBe(2);
		expect(out.new_lines).toBe(3);
	});

	it('reports a stale range with the corrected range when the checksum line moved', () => {
		const out = applyRangeEdit('a\nb\nc\nd\ne', 2, 3, 'd', 'x');
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe('stale');
		expect(out.details).toEqual({
			current: 'b',
			matched_line: 4,
			corrected: { start: 4, end: 5 }
		});
	});

	it('rejects an end_line past the file end', () => {
		const out = applyRangeEdit('a\nb\nc', 2, 9, 'b', 'x');
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe('out_of_range');
	});

	it('supports deletion via empty new_text (negative shift)', () => {
		const out = applyRangeEdit('a\nb\nc', 2, 2, 'b', '');
		if (!out.ok) throw new Error(out.message);
		expect(out.content).toBe('a\nc');
		expect(out.shift).toEqual({ after: 2, by: -1 });
	});
});

describe('edit tool range mode', () => {
	it('applies a range edit and returns the diff + shift', async () => {
		const root = makeTmpDir('edit-range-');
		writeFileSync(join(root, 'f.txt'), 'a\nb\nc\nd');
		const result = await editTool(root).handler({
			file_path: 'f.txt',
			mode: 'range',
			start_line: 2,
			end_line: 2,
			checksum: 'b',
			new_string: 'B\nbb'
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('a\nB\nbb\nc\nd');
		expect(result.result).toMatchObject({
			requested_range: { start: 2, end: 2 },
			applied_range: { start: 2, end: 3 },
			shift: { after: 2, by: 1 },
			total_lines: 5
		});
	});

	it('errors when range mode is missing its fields', async () => {
		const root = makeTmpDir('edit-range-');
		writeFileSync(join(root, 'f.txt'), 'a\nb\nc');
		const result = await editTool(root).handler({
			file_path: 'f.txt',
			mode: 'range',
			start_line: 2,
			end_line: 2,
			new_string: 'x'
		});
		expect(result.ok).toBe(false);
	});

	it('exact mode still works unchanged', async () => {
		const root = makeTmpDir('edit-range-');
		writeFileSync(join(root, 'f.txt'), 'a\nb\nc');
		const result = await editTool(root).handler({
			file_path: 'f.txt',
			old_string: 'b',
			new_string: 'B'
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('a\nB\nc');
	});

	it('errors on a missing file in range mode', async () => {
		const root = makeTmpDir('edit-range-');
		const result = await editTool(root).handler({
			file_path: 'nope.txt',
			mode: 'range',
			start_line: 1,
			end_line: 1,
			checksum: 'x',
			new_string: 'y'
		});
		expect(result.ok).toBe(false);
	});
});
