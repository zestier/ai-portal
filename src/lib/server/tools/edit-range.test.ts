import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyRangeEdit, buildEditRangeTools } from './edit-range';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function editRangeTool(root: string) {
	return buildEditRangeTools(root)[0]!;
}

describe('applyRangeEdit', () => {
	it('replaces a range and reports the applied range + line shift', () => {
		const out = applyRangeEdit('a\nb\nc\nd\ne', 2, 3, 'b', 'x\ny\nz');
		if (!out.ok) throw new Error(out.message);
		expect(out.content).toBe('a\nx\ny\nz\nd\ne');
		expect(out.result.applied_range).toEqual({ start: 2, end: 4 });
		expect(out.result.shift).toEqual({ after: 3, by: 1 });
		expect(out.result.total_lines).toBe(6);
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

	it('reports a stale range with no correction when the checksum is absent', () => {
		const out = applyRangeEdit('a\nb\nc\nd\ne', 2, 3, 'zzz', 'x');
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.reason).toBe('stale');
		expect(
			(out.details as { corrected: { start: number; end: number } | null }).corrected
		).toBeNull();
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
		expect(out.result.shift).toEqual({ after: 2, by: -1 });
	});
});

describe('edit_range tool', () => {
	it('applies a range edit and returns the diff + shift in the view', async () => {
		const root = makeTmpDir('edit-range-tool-');
		writeFileSync(join(root, 'f.txt'), 'a\nb\nc\nd');
		const result = await editRangeTool(root).handler({
			file_path: 'f.txt',
			start_line: 2,
			end_line: 2,
			checksum: 'b',
			new_text: 'B\nbb'
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('a\nB\nbb\nc\nd');
		expect(result.result).toMatchObject({
			requested_range: { start: 2, end: 2 },
			applied_range: { start: 2, end: 3 },
			shift: { after: 2, by: 1 },
			total_lines: 5
		});
		expect(result.views?.[0].type).toBe('text');
	});

	it('errors cleanly on a missing file', async () => {
		const root = makeTmpDir('edit-range-tool-');
		const result = await editRangeTool(root).handler({
			file_path: 'nope.txt',
			start_line: 1,
			end_line: 1,
			checksum: 'x',
			new_text: 'y'
		});
		expect(result.ok).toBe(false);
	});

	it('derives an edit permission request from the target path', () => {
		const root = makeTmpDir('edit-range-tool-');
		const req = editRangeTool(root).derivePermissionRequest?.({
			file_path: 'f.txt',
			start_line: 1,
			end_line: 1,
			checksum: 'a',
			new_text: 'b'
		});
		expect(req).toEqual({ permissionKind: 'edit', path: join(root, 'f.txt') });
	});
});
