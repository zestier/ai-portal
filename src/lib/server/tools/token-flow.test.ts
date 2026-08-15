import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from '../../../../tests/helpers/tmp';
import { buildReadTools } from './read';
import { buildEditFileTools } from './edit-file';

// The experiment's consolidated flow, exactly as the model would use it with
// the folded-in tools:
//   1. read (auto) a large file -> outline, giving a block's line range +
//      header text
//   2. edit mode:'range' that block by line numbers + header checksum (no
//      old-block echo, no pre-edit whole-file read)
//   3. read again (auto, broad) -> the delta since the last read, not the file
describe('read + edit range flow (consolidated)', () => {
	it('navigates by outline, edits by range, and sees only the delta', async () => {
		const root = makeTmpDir('token-flow-');
		writeFileSync(join(root, 'svc.py'), bigPy());
		const read = buildReadTools(root)[0]!;
		const edit = buildEditFileTools(root).find((t) => t.name === 'edit')!;

		// 1. read -> outline; grab the method_0 block.
		const o = await read.handler({ file_path: 'svc.py', offset: 1, limit: 100 });
		if (!o.ok) throw new Error(o.error.message);
		const blocks = (
			o.result as {
				file: { outline: { line: number; extent: number; text: string }[] };
			}
		).file.outline;
		const block = blocks[1];
		expect(block.text).toBe('def method_0(self):');

		// 2. edit range with outline-derived line numbers + header checksum.
		const er = await edit.handler({
			file_path: 'svc.py',
			anchor: block.text,
			lines: block.extent - block.line + 1,
			new_string: '    def method_0(self):\n        return -1\n        print("x")'
		});
		if (!er.ok) throw new Error(er.error.message);
		expect(er.result).toMatchObject({ shift: { after: block.extent, by: 1 } });

		// 3. broad re-read -> delta (file changed since step 1), hunks only.
		const rd = await read.handler({ file_path: 'svc.py', offset: 1, limit: 100 });
		if (!rd.ok) throw new Error(rd.error.message);
		expect((rd.result as { type: string }).type).toBe('delta');
		const text = (rd.views?.[0] as { text: string }).text;
		expect(text).toContain('print("x")');
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
