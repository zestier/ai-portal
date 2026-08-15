import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from '../../../../tests/helpers/tmp';
import { buildOutlineTools } from './outline';
import { buildEditRangeTools } from './edit-range';
import { buildReadDeltaTools } from './read-delta';

// The experiment's "try them all together" flow, exactly as the model would:
//   1. outline a large file → get a block's line range + header text
//   2. edit_range that block by line numbers + header checksum (no old-block
//      echo, no pre-edit whole-file read)
//   3. read_delta → see only the change, not the whole file
describe('outline + edit_range + read_delta flow', () => {
	it('navigates, edits by range, and sees only the delta', async () => {
		const root = makeTmpDir('token-flow-');
		writeFileSync(join(root, 'svc.py'), bigPy());

		const outline = buildOutlineTools(root)[0]!;
		const editRange = buildEditRangeTools(root)[0]!;
		const readDelta = buildReadDeltaTools(root)[0]!;

		// 1. outline → the method block (header text + line range)
		const o = await outline.handler({ file_path: 'svc.py' });
		if (!o.ok) throw new Error(o.error.message);
		const ofile = o.result as {
			file: { blocks: { line: number; extent: number; text: string }[] };
		};
		const block = ofile.file.blocks[1];
		expect(block.text).toBe('def method_0(self):');

		// 2. edit_range the block using outline-derived line numbers + header
		//    text as checksum; replacement adds a line, so shift = +1.
		const er = await editRange.handler({
			file_path: 'svc.py',
			start_line: block.line,
			end_line: block.extent,
			checksum: block.text,
			new_text: '    def method_0(self):\n        return -1\n        print("x")'
		});
		if (!er.ok) throw new Error(er.error.message);
		expect(er.result).toMatchObject({ shift: { after: block.extent, by: 1 } });

		// 3. first read_delta is a full read (records the snapshot)…
		const rd1 = await readDelta.handler({ file_path: 'svc.py' });
		if (!rd1.ok) throw new Error(rd1.error.message);
		expect((rd1.result as { type: string }).type).toBe('text');

		// …edit again…
		const er2 = await editRange.handler({
			file_path: 'svc.py',
			start_line: block.line,
			end_line: block.line + 1,
			checksum: '    def method_0(self):',
			new_text: '    def method_0(self):\n        return -2'
		});
		if (!er2.ok) throw new Error(er2.error.message);

		// …and a second read_delta returns only the hunks.
		const rd2 = await readDelta.handler({ file_path: 'svc.py' });
		if (!rd2.ok) throw new Error(rd2.error.message);
		expect((rd2.result as { type: string }).type).toBe('delta');
		const text = (rd2.views?.[0] as { text: string }).text;
		expect(text).toContain('return -2');
		expect(text).not.toContain('method_19'); // far-away content not re-sent
	});
});

function bigPy(): string {
	const lines: string[] = [];
	lines.push('import os', '');
	lines.push('class Service:');
	for (let i = 0; i < 20; i++) {
		lines.push(`    def method_${i}(self):`);
		lines.push(`        return ${i}`);
	}
	lines.push('');
	lines.push('def main():');
	lines.push('    pass');
	return lines.join('\n');
}
