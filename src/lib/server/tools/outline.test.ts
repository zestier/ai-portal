import { describe, it, expect } from 'vitest';
import { computeOutline } from './outline';

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

	it('skips multi-line signature continuation headers', () => {
		const o = computeOutline(
			['export function foo(', '\targ: string,', '): Promise<string> {', '\treturn arg;', '}'].join(
				'\n'
			)
		);
		expect(o.format).toBe('normal');
		// `): Promise<string> {` is a continuation, not a block of its own; the
		// function block's extent closes where the continuation dedents.
		expect(o.blocks).toEqual([{ line: 1, depth: 0, text: 'export function foo(', extent: 2 }]);
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
