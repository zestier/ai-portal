import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOutlineTools, computeOutline } from './outline';
import { makeTmpDir } from '../../../../tests/helpers/tmp';

function outlineTool(root: string) {
	return buildOutlineTools(root)[0]!;
}

// Build a >40-line python file with a class, 20 one-line-ish methods, and a
// top-level main, so the handler takes the outline path.
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

describe('computeOutline (pure-indent, no keyword list)', () => {
	it('finds block headers at depth 0 and 1, filters depth-2 control flow', () => {
		const o = computeOutline(
			[
				'class Foo:',
				'    def bar(self):',
				'        if x:',
				'            pass',
				'    def baz(self):',
				'        return 1',
				'',
				'def top():',
				'    pass'
			].join('\n')
		);
		expect(o.format).toBe('normal');
		expect(o.blocks).toEqual([
			{ line: 1, depth: 0, text: 'class Foo:', extent: 7 },
			{ line: 2, depth: 1, text: 'def bar(self):', extent: 4 },
			{ line: 5, depth: 1, text: 'def baz(self):', extent: 7 },
			{ line: 8, depth: 0, text: 'def top():', extent: 9 }
		]);
	});

	it('merges an Allman `{`-only opener into the declaration above it', () => {
		const o = computeOutline(['int f()', '{', '    return 1;', '}'].join('\n'));
		expect(o.blocks).toEqual([{ line: 1, depth: 0, text: 'int f() {', extent: 3 }]);
	});

	it('reports flat files (single indent level) as format flat', () => {
		const o = computeOutline('a\nb\nc\nd');
		expect(o.format).toBe('flat');
		expect(o.blocks).toEqual([]);
	});

	it('reports minified files (a line over the cap) as format minified', () => {
		const o = computeOutline(`let x = '${'y'.repeat(2500)}';\nfoo(x);`);
		expect(o.format).toBe('minified');
		expect(o.blocks).toEqual([]);
	});
});

describe('outline tool', () => {
	it('delegates small files to the full read result', async () => {
		const root = makeTmpDir('outline-tool-');
		writeFileSync(join(root, 'small.txt'), 'a\nb\nc');
		const result = await outlineTool(root).handler({ file_path: 'small.txt' });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.result).toMatchObject({
			type: 'text',
			file: { filePath: 'small.txt', content: 'a\nb\nc', totalLines: 3 }
		});
	});

	it('returns an indentation outline for a large file', async () => {
		const root = makeTmpDir('outline-tool-');
		writeFileSync(join(root, 'service.py'), bigPy());
		const result = await outlineTool(root).handler({ file_path: 'service.py' });
		if (!result.ok) throw new Error(result.error.message);
		const file = result.result as { type: string; file: Record<string, unknown> };
		expect(file.type).toBe('text');
		expect(file.file.format).toBe('normal');
		const blocks = file.file.blocks as { line: number; depth: number; text: string }[];
		// class (0) + 20 methods (1) + main (0)
		expect(blocks).toHaveLength(22);
		expect(blocks[0]).toEqual({ line: 3, depth: 0, text: 'class Service:', extent: 44 });
		expect(blocks[1].text).toBe('def method_0(self):');
		expect(blocks[21]).toMatchObject({ text: 'def main():', depth: 0 });
	});

	it('errors cleanly on a missing file', async () => {
		const root = makeTmpDir('outline-tool-');
		const result = await outlineTool(root).handler({ file_path: 'nope.txt' });
		expect(result.ok).toBe(false);
	});
});
