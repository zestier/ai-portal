import { describe, it, expect } from 'vitest';
import {
	project,
	combineOmitted,
	withOmitted,
	isEmptyValue
} from '../src/lib/server/tools/project';

describe('project', () => {
	const keep = ['id', 'title', 'status'] as const;

	it('passes the input through untouched when verbose', () => {
		const row = { id: '1', title: 'a', status: 'open', secret: 'keep me', payload: { big: 1 } };
		const { value, omitted } = project(row, { verbose: true, keep });
		expect(value).toBe(row);
		expect(omitted).toEqual([]);
	});

	it('keeps only allowlisted fields and reports dropped non-empty fields', () => {
		const row = { id: '1', title: 'a', status: 'open', secret: 'x', payload: { big: 1 } };
		const { value, omitted } = project(row, { keep });
		expect(value).toEqual({ id: '1', title: 'a', status: 'open' });
		expect(omitted).toEqual(['payload', 'secret']);
	});

	it('drops null/undefined/empty fields entirely without listing them as omitted', () => {
		const row = {
			id: '1',
			title: 'a',
			status: '',
			note: null,
			tags: [],
			meta: {},
			blank: undefined,
			real: 'dropped'
		};
		const { value, omitted } = project(row, { keep });
		// status is allowlisted but blank -> dropped, not kept, not omitted-listed
		expect(value).toEqual({ id: '1', title: 'a' });
		// only `real` carried information; the empty fields are not surfaced
		expect(omitted).toEqual(['real']);
	});

	it('preserves allowlisted empty containers but drops allowlisted absent values', () => {
		const row = { id: '1', title: 'a', status: null, value: [], extra: {} };
		const { value, omitted } = project(row, { keep: ['id', 'title', 'status', 'value'] });
		// `value: []` is allowlisted and an empty container -> kept (could be meaningful);
		// `status: null` is absent -> dropped; non-allowlisted empty `extra` -> dropped silently.
		expect(value).toEqual({ id: '1', title: 'a', value: [] });
		expect(omitted).toEqual([]);
	});

	it('projects each element of an array and unions dropped field names', () => {
		const rows = [
			{ id: '1', title: 'a', extra: 'one' },
			{ id: '2', title: 'b', other: 'two' }
		];
		const { value, omitted } = project(rows, { keep });
		expect(value).toEqual([
			{ id: '1', title: 'a' },
			{ id: '2', title: 'b' }
		]);
		expect(omitted).toEqual(['extra', 'other']);
	});

	it('returns no omitted when nothing meaningful is dropped', () => {
		const row = { id: '1', title: 'a', status: 'open' };
		const { value, omitted } = project(row, { keep });
		expect(value).toEqual(row);
		expect(omitted).toEqual([]);
	});

	it('passes non-object values through unchanged', () => {
		expect(project('hello', { keep }).value).toBe('hello');
		expect(project(42, { keep }).value).toBe(42);
		expect(project(['plain', 'strings'], { keep }).value).toEqual(['plain', 'strings']);
	});
});

describe('combineOmitted', () => {
	it('unions and sorts omitted lists across projections', () => {
		const a = project({ id: '1', x: 1 }, { keep: ['id'] });
		const b = project({ id: '2', y: 2, x: 3 }, { keep: ['id'] });
		expect(combineOmitted(a, b)).toEqual(['x', 'y']);
	});
});

describe('withOmitted', () => {
	it('attaches _omitted only when fields were dropped', () => {
		expect(withOmitted({ results: [] }, [])).toEqual({ results: [] });
		expect(withOmitted({ results: [] }, ['a', 'b'])).toEqual({
			results: [],
			_omitted: ['a', 'b']
		});
	});
});

describe('isEmptyValue', () => {
	it('treats null/undefined/blank/empty containers as empty', () => {
		for (const v of [null, undefined, '', [], {}]) expect(isEmptyValue(v)).toBe(true);
		for (const v of [0, false, 'x', [1], { a: 1 }]) expect(isEmptyValue(v)).toBe(false);
	});
});
