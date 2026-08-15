// Compact-by-default projection for tool results. Portal `ToolResult` envelopes
// are serialized verbatim into the model's context (see `types.ts`), so every
// field a handler returns costs tokens. `project` trims a domain record (or
// array of records) down to an explicit per-shape allowlist of model-relevant
// fields, dropping the rest along with any null/undefined/empty values.
//
// The default is intentionally the lean shape: models are unreliable at opting
// into savings, so handlers project by default and expose an opt-in `fields`
// selector that either names specific top-level fields to return (e.g.
// `["plan"]` — including fields the compact view omits) or asks for the whole
// record with `"all"`. The compact result's `_omitted` marker doubles as the
// menu of names a follow-up `fields` request can ask for.
//
// Allowlists (not blacklists) are deliberate: they age better as schemas grow,
// since a newly added noisy field is dropped automatically rather than leaking
// until someone remembers to blacklist it.

import { z } from 'zod';

// The model-facing `fields` selector. Omit it for the compact view; otherwise
// name one or more top-level fields to return. Keeping one JSON type here is
// deliberate: mixed string/array schemas are coerced to strings by some model
// providers.
export type FieldSelector = readonly string[];

// Normalize the raw `fields` argument into compact-default (`undefined`) or an
// explicit field list. The string arm is defensive for direct callers outside
// schema validation and always rejects; custom-tool schemas advertise and
// accept non-empty arrays only.
export function normalizeFieldSelector(
	fields: FieldSelector | string | undefined
): readonly string[] | undefined {
	if (fields === undefined) return undefined;
	if (typeof fields === 'string') {
		throw new Error(
			`Invalid "fields" value: ${JSON.stringify(fields)}. ${fieldsShapeError(fields)}`
		);
	}
	if (fields.length === 0) {
		throw new Error(
			'Invalid "fields" value: no fields were requested. Omit "fields" for the compact view.'
		);
	}
	return fields;
}

function fieldsShapeError(fields: string): string {
	if (fields.startsWith('[') || fields.includes('","')) {
		return (
			'"fields" must be a JSON array, not a JSON-encoded string. ' +
			'Send {"fields":["id","title"]}, not {"fields":"[\\"id\\",\\"title\\"]"}.'
		);
	}
	return (
		'"fields" must be an array of field names. ' +
		`For a single field, use an array like [${JSON.stringify(fields)}], not ` +
		`${JSON.stringify(fields)}. Send {"fields":[${JSON.stringify(fields)}]}.`
	);
}

// Shared Zod schema for the optional `fields` argument across tools.
export const FieldsArg = z
	.array(z.string().trim().min(1).max(100))
	.min(1, 'At least one field must be requested; omit "fields" for the compact view.')
	.max(50)
	.optional();

// Shared JSON-Schema fragment advertising the array-only `fields` parameter.
export const FIELDS_PARAM = {
	type: 'array',
	items: { type: 'string' },
	description:
		'Optional. Omit for compact view; pass array of top-level field names to return exactly those (`_omitted` lists dropped).'
} as const;

export interface Projection<T> {
	value: T;
	// Field names that carried information but were dropped from the compact
	// shape, sorted and de-duplicated. Empty/null/blank fields are NOT listed:
	// re-fetching them via `fields` would yield nothing, so surfacing them would
	// be noise and could provoke pointless re-calls. This list is purely
	// descriptive metadata — a passive escape hatch (and the menu of names a
	// follow-up `fields` request can ask for), not an instruction.
	omitted: string[];
}

// A value is "empty" (and thus carries no information worth recalling) when it
// is null/undefined, a blank string, an empty array, or an empty object.
export function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined || value === '') return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
	return false;
}

// A value is "absent" when it carries no recoverable content at all: null,
// undefined, or a blank string. Unlike `isEmptyValue` this does NOT treat an
// empty array/object as absent — for an explicitly allowlisted field an empty
// container can be meaningful (e.g. a fact whose `value` is `[]`), so we keep it
// rather than silently dropping it.
function isAbsentValue(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

function projectRecord(
	record: Record<string, unknown>,
	keep: ReadonlySet<string>,
	dropped: Set<string>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (keep.has(key)) {
			// Allowlisted: keep it, including empty containers, but skip values that
			// are truly absent (re-fetching them via `fields` would yield nothing).
			if (isAbsentValue(value)) continue;
			out[key] = value;
		} else {
			if (isEmptyValue(value)) continue; // no information lost; never list it
			dropped.add(key);
		}
	}
	return out;
}

// Project a record or array of records according to the `fields` selector.
// Two modes:
//   - `fields` omitted   → compact default: project to the `keep` allowlist and
//                          report dropped non-empty field names in `omitted`.
//   - `fields` is a list → return exactly those top-level fields (a deliberate,
//                          model-chosen shape), so `omitted` is suppressed:
//                          listing what *else* was dropped would be noise when
//                          the caller already named what it wanted. Requested
//                          names that exist on no record (and aren't part of the
//                          compact allowlist) are rejected with a throw, rather
//                          than silently returning nothing — a guessed-wrong
//                          field name should fail loudly so the model corrects.
// Non-object inputs (and non-object array elements) pass through unchanged.
//
// `opts.validate` (default true) controls the unknown-field throw. Handlers that
// apply ONE `fields` selector across several heterogeneous shapes should instead
// validate once via `assertFieldsKnown` (against the union of those shapes) and
// pass `validate: false` here, so a field valid on one shape isn't rejected for
// being absent on a sibling shape.
export function project<T>(
	input: T,
	opts: { keep: readonly string[]; fields?: FieldSelector | string; validate?: boolean }
): Projection<T> {
	const selector = normalizeFieldSelector(opts.fields);
	const explicit = selector !== undefined;
	if (explicit && opts.validate !== false) {
		assertFieldsKnown(selector, [{ input, keep: opts.keep }]);
	}
	const keep = new Set(explicit ? selector : opts.keep);
	const dropped = new Set<string>();
	let value: unknown;
	if (Array.isArray(input)) {
		value = input.map((row) =>
			row && typeof row === 'object' && !Array.isArray(row)
				? projectRecord(row as Record<string, unknown>, keep, dropped)
				: row
		);
	} else if (input && typeof input === 'object') {
		value = projectRecord(input as Record<string, unknown>, keep, dropped);
	} else {
		value = input;
	}
	return { value: value as T, omitted: explicit ? [] : [...dropped].sort() };
}

// The set of field names a `fields` request may legitimately ask for: the
// compact `keep` allowlist (always valid — those are curated field names for the
// shape, present in the data or not) plus every key actually present on any
// object record in `input`. Never empty when `keep` is non-empty, so an empty
// list / scalar / null still validates against the allowlist rather than
// silently accepting anything.
function collectKnownFields(input: unknown, keep: readonly string[]): Set<string> {
	const known = new Set<string>(keep);
	const addFrom = (rec: unknown) => {
		if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
			for (const k of Object.keys(rec)) known.add(k);
		}
	};
	if (Array.isArray(input)) input.forEach(addFrom);
	else addFrom(input);
	return known;
}

// Throw a descriptive error if any explicitly requested field name exists on
// none of the given shapes — neither in a shape's curated `keep` allowlist nor
// among the keys present in its data. `shapes` is unioned so a handler
// projecting several shapes with one selector accepts a name valid for *any* of
// them (and a shape's allowlist still counts even when that shape's data is
// empty). No-op unless `fields` is an explicit name list. The error lists the
// valid names so the model can self-correct.
export function assertFieldsKnown(
	fields: FieldSelector | string | undefined,
	shapes: Array<{ input: unknown; keep: readonly string[] }>
): void {
	const selector = normalizeFieldSelector(fields);
	if (selector === undefined) return;
	const known = new Set<string>();
	for (const shape of shapes) {
		for (const name of collectKnownFields(shape.input, shape.keep)) known.add(name);
	}
	const unknown = selector.filter((f) => !known.has(f));
	if (unknown.length === 0) return;
	throw new Error(
		`Unknown field(s) requested: ${unknown.join(', ')}. ` +
			`Available fields: ${[...known].sort().join(', ')}.`
	);
}

// Union the `omitted` lists of several projections into one sorted, de-duplicated
// list — used by handlers that project multiple shapes into a single result.
// Note: attribution is intentionally collapsed. A name like `conversationId` may
// originate from any of the combined shapes; the model cannot tell which.
export function combineOmitted(...projections: Projection<unknown>[]): string[] {
	return [...new Set(projections.flatMap((p) => p.omitted))].sort();
}

// Attach a passive `_omitted` marker to a result object, but only when fields
// were actually dropped. Keeping it absent otherwise means its mere presence is
// a meaningful signal. Callers must ensure their domain payload does not already
// use an `_omitted` key.
export function withOmitted<T extends Record<string, unknown>>(
	result: T,
	omitted: string[]
): T & { _omitted?: string[] } {
	return omitted.length ? { ...result, _omitted: omitted } : result;
}
