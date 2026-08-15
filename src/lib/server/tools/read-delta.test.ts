import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReadDeltaTools } from './read-delta';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function deltaTool(root: string) {
	return buildReadDeltaTools(root)[0]!;
}

describe('read_delta tool', () => {
	it('first read returns the full file and records its hash', async () => {
		const root = makeTmpDir('read-delta-tool-');
		writeFileSync(join(root, 'f.txt'), 'a\nb\nc');
		const result = await deltaTool(root).handler({ file_path: 'f.txt' });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { content: 'a\nb\nc', totalLines: 3 }
		});
	});

	it('an unchanged re-read returns a short marker, not the content', async () => {
		const root = makeTmpDir('read-delta-tool-');
		const path = join(root, 'f.txt');
		writeFileSync(path, 'a\nb\nc');
		await deltaTool(root).handler({ file_path: 'f.txt' });
		const second = await deltaTool(root).handler({ file_path: 'f.txt' });
		if (!second.ok) throw new Error(second.error.message);
		expect((second.result as { type: string }).type).toBe('unchanged');
		expect((second.views?.[0] as { text: string }).text).toContain('unchanged');
		expect((second.views?.[0] as { text: string }).text).not.toContain('a\nb\nc');
	});

	it('a changed file returns only the delta hunks and refreshes the snapshot', async () => {
		const root = makeTmpDir('read-delta-tool-');
		const path = join(root, 'f.txt');
		// 30 lines so context lines don't swallow the whole file
		writeFileSync(path, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
		await deltaTool(root).handler({ file_path: 'f.txt' });
		writeFileSync(
			path,
			Array.from({ length: 30 }, (_, i) => (i === 1 ? 'LINE 1' : `line ${i}`)).join('\n')
		);
		const result = await deltaTool(root).handler({ file_path: 'f.txt' });
		if (!result.ok) throw new Error(result.error.message);
		const body = result.result as {
			type: string;
			old_lines: number;
			new_lines: number;
			shift: number;
			hunks: unknown[];
		};
		expect(body.type).toBe('delta');
		expect(body.old_lines).toBe(30);
		expect(body.new_lines).toBe(30);
		expect(body.shift).toBe(0);
		expect(body.hunks.length).toBeGreaterThan(0);
		const text = (result.views?.[0] as { text: string }).text;
		expect(text).toContain('+LINE 1');
		expect(text).not.toContain('line 25'); // far-away content not re-sent
		// snapshot refreshed: a third read sees no change
		const third = await deltaTool(root).handler({ file_path: 'f.txt' });
		if (!third.ok) throw new Error(third.error.message);
		expect((third.result as { type: string }).type).toBe('unchanged');
	});
});
