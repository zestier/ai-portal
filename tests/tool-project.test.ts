import { describe, it, expect } from 'vitest';
import {
	project,
	combineOmitted,
	withOmitted,
	isEmptyValue,
	normalizeFieldSelector,
	assertFieldsKnown
} from '../src/lib/server/tools/project';

describe('project', () => {
	const keep = ['id', 'title', 'status'] as const;

	it('passes the input through untouched for fields:"all"', () => {
		const row = { id: '1', title: 'a', status: 'open', secret: 'keep me', payload: { big: 1 } };
		const { value, omitted } = project(row, { fields: 'all', keep });
		expect(value).toBe(row);
		expect(omitted).toEqual([]);
	});

	it('treats only a bare "*" as "all"; inside an array it is a literal field name', () => {
		const row = { id: '1', secret: 'x' };
		expect(project(row, { fields: '*', keep }).value).toBe(row);
		// A list entry is never a sentinel, so ["*"] asks for a (nonexistent) field.
		expect(() => project(row, { fields: ['*'], keep })).toThrow(/Unknown field/);
		// "all" inside a list is likewise literal, not the everything-sentinel.
		expect(() => project(row, { fields: ['id', 'all'], keep })).toThrow(/Unknown field/);
	});

	it('selects exactly the requested fields, including ones omitted by default', () => {
		const row = { id: '1', title: 'a', status: 'open', plan: 'big plan', secret: 'x' };
		// `plan` is not in the default allowlist but is explicitly requestable.
		const { value, omitted } = project(row, { fields: ['plan'], keep });
		expect(value).toEqual({ plan: 'big plan' });
		// Explicit selection is a deliberate shape, so nothing is reported as omitted.
		expect(omitted).toEqual([]);
	});

	it('selects a field actually named "all" or "default" when present', () => {
		const row = { id: '1', all: 'A', default: 'D', secret: 'x' };
		expect(project(row, { fields: ['all'], keep }).value).toEqual({ all: 'A' });
		expect(project(row, { fields: ['default'], keep }).value).toEqual({ default: 'D' });
	});

	it('rejects a bare non-sentinel string instead of treating it as a one-field selector', () => {
		const row = { id: '1', plan: 'p', secret: 'x' };
		expect(() => project(row, { fields: 'plan', keep })).toThrow(/use an array like \["plan"\]/);
	});

	it('treats a bare "default" (and an empty array) like omitting fields', () => {
		const row = { id: '1', title: 'a', status: 'open', secret: 'x', payload: { big: 1 } };
		const omittedResult = project(row, { keep });
		expect(project(row, { fields: 'default', keep })).toEqual(omittedResult);
		expect(project(row, { fields: [], keep })).toEqual(omittedResult);
	});

	it('throws on requested field names that exist on no record', () => {
		const row = { id: '1', title: 'a' };
		expect(() => project(row, { fields: ['nope'], keep })).toThrow(/Unknown field\(s\) requested/);
		// The error advertises the valid names so the model can self-correct.
		expect(() => project(row, { fields: ['nope'], keep })).toThrow(/Available fields/);
	});

	it('accepts allowlisted field names even when absent/blank in this record', () => {
		// `status` is in `keep` but blank here; requesting it is still valid (no throw).
		const row = { id: '1', title: 'a', status: '' };
		expect(() => project(row, { fields: ['status'], keep })).not.toThrow();
	});

	it('validates against the keep allowlist even when there are no records', () => {
		// Empty input has no data keys, but the curated allowlist is still valid:
		// a keep field is accepted, a non-keep name is rejected.
		expect(() => project([], { fields: ['id'], keep })).not.toThrow();
		expect(() => project([], { fields: ['whatever'], keep })).toThrow(/Unknown field/);
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

describe('normalizeFieldSelector', () => {
	it('maps undefined, bare "default", and an empty array to undefined (compact)', () => {
		expect(normalizeFieldSelector(undefined)).toBeUndefined();
		expect(normalizeFieldSelector('default')).toBeUndefined();
		expect(normalizeFieldSelector([])).toBeUndefined();
	});

	it('maps only a bare "all"/"*" to "all"', () => {
		expect(normalizeFieldSelector('all')).toBe('all');
		expect(normalizeFieldSelector('*')).toBe('all');
	});

	it('rejects a bare field name, guiding toward an array', () => {
		expect(() => normalizeFieldSelector('plan')).toThrow(/must be an array of field names/);
		expect(() => normalizeFieldSelector('plan')).toThrow(
			/use an array like \["plan"\], not "plan"/
		);
	});

	it('rejects a stringified array, flagging the JSON-string mistake', () => {
		const stringified = '["id","title","priority","body"]';
		expect(() => normalizeFieldSelector(stringified)).toThrow(/JSON-encoded string/);
		// The whole blob must NOT leak into an unknown-field list.
		expect(() => normalizeFieldSelector(stringified)).not.toThrow(/Unknown field/);
	});

	it('takes array entries literally — no sentinel collapsing inside a list', () => {
		// "all"/"*"/"default" inside an array are real field names, not sentinels.
		expect(normalizeFieldSelector(['id', '*'])).toEqual(['id', '*']);
		expect(normalizeFieldSelector(['all'])).toEqual(['all']);
		expect(normalizeFieldSelector(['default', 'plan'])).toEqual(['default', 'plan']);
	});
});

describe('assertFieldsKnown', () => {
	it('no-ops for compact/all selectors and undefined', () => {
		const shapes = [{ input: { id: '1' }, keep: ['id'] }];
		expect(() => assertFieldsKnown(undefined, shapes)).not.toThrow();
		expect(() => assertFieldsKnown('default', shapes)).not.toThrow();
		expect(() => assertFieldsKnown('all', shapes)).not.toThrow();
	});

	it('accepts a field valid for ANY shape in the union', () => {
		const shapes = [
			{ input: { id: '1', displayName: 'x' }, keep: ['id'] },
			{ input: [{ id: 'f1', predicate: 'p' }], keep: ['id'] }
		];
		// `displayName` exists only on the first shape; `predicate` only on the second.
		expect(() => assertFieldsKnown(['displayName'], shapes)).not.toThrow();
		expect(() => assertFieldsKnown(['predicate'], shapes)).not.toThrow();
	});

	it('throws when a field exists on no shape', () => {
		const shapes = [{ input: { id: '1' }, keep: ['id'] }];
		expect(() => assertFieldsKnown(['nope'], shapes)).toThrow(/Unknown field/);
	});

	it("counts an empty shape's keep allowlist toward the union", () => {
		// `facts` is empty here, but its allowlist field `predicate` is still valid.
		const shapes = [
			{ input: { id: '1' }, keep: ['id'] },
			{ input: [], keep: ['predicate'] }
		];
		expect(() => assertFieldsKnown(['predicate'], shapes)).not.toThrow();
		expect(() => assertFieldsKnown(['bogus'], shapes)).toThrow(/Unknown field/);
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
