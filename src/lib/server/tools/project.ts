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

// The model-facing `fields` selector. Either an explicit list of top-level field
// names to return, the literal `"all"` for the full unprojected record, or
// `"default"` for the compact view (the same as omitting `fields`). `"all"` and
// `"default"` are only meaningful as the *whole* value — inside an array every
// entry is taken literally as a field name, so a record genuinely containing an
// `all` or `default` field can still be selected.
export type FieldSelector = readonly string[] | 'all' | 'default';

// Normalize the raw, leniently-typed `fields` argument into one of three modes:
// `undefined` (compact default), `"all"` (full record), or an explicit name
// list. The string sentinels are recognized only as a bare value:
//   - `"all"` (or the glob-ish `"*"`) → the full record;
//   - `"default"` → the compact view, so a model that feels it must pass
//     *something* can still ask for the normal view without enumerating fields;
//   - any OTHER bare string → rejected with a thrown Error. A single-field
//     selection must be written as an array (`["plan"]`, not `"plan"`); a bare
//     non-sentinel string is almost always a stringified array or a single
//     field name in the wrong shape, so failing loudly here is clearer than
//     silently wrapping it into a one-element list.
// Array entries are NEVER treated as sentinels — they are literal field names,
// so `["all"]` selects a field actually named `all` (and errors in `project` if
// no such field exists). An empty array means "no selection" → the compact view.
export function normalizeFieldSelector(
	fields: FieldSelector | string | undefined
): readonly string[] | 'all' | undefined {
	if (fields === undefined) return undefined;
	if (typeof fields === 'string') {
		if (fields === 'all' || fields === '*') return 'all';
		if (fields === 'default') return undefined;
		const looksJson = fields.startsWith('[') || fields.includes('","');
		throw new Error(
			`Invalid "fields" value: ${JSON.stringify(fields)}. ` +
				'`fields` must be an array of field names (e.g. ["id","title"]) or one of the ' +
				'bare sentinels "all" / "default". ' +
				(looksJson
					? 'This looks like a JSON-encoded string — pass a real array, not a string. '
					: '') +
				'For a single field, use an array like ["plan"], not "plan".'
		);
	}
	return fields.length === 0 ? undefined : fields;
}

// Shared Zod schema for the optional `fields` argument across tools. The only
// accepted shapes are an array of field names or the bare sentinels
// "all"/"default" (plus the tolerated "*" alias). The string arm stays wide at
// the Zod layer so a bare non-sentinel string reaches `normalizeFieldSelector`,
// which rejects it with a descriptive shape-error message rather than silently
// wrapping it into a one-element list.
export const FieldsArg = z
	.union([z.array(z.string().trim().min(1).max(100)).max(50), z.string().trim().min(1).max(100)])
	.optional();

// Shared JSON-Schema fragment advertising the `fields` parameter on a tool. The
// advertised shape is the clean `string[] | "all" | "default"`; the extra
// leniency in `normalizeFieldSelector` (bare `"*"`, empty array) is an
// unadvertised safety net.
export const FIELDS_PARAM = {
	description:
		'Optional. Selects how much of each record to return. Omit (or pass "default") for ' +
		'a compact view with the fields you usually need (dropped field names are listed in ' +
		'`_omitted`). Pass an array of top-level field names to fetch exactly those — including ' +
		'fields omitted by default, e.g. ["plan"] — or "all" for the complete record. Field ' +
		'names must exist on the record; unknown names are rejected. "all"/"default" are ' +
		'sentinels only as the whole value, not inside the array. Prefer the default unless you ' +
		'need something specific.',
	oneOf: [
		{ type: 'array', items: { type: 'string' } },
		{ type: 'string', enum: ['default', 'all'] }
	]
} as const;

// Prose variant of `FIELDS_PARAM.description` for appending to tool descriptions.
export const FIELDS_NOTE =
	'By default this returns a compact view; pass `fields` (an array of existing top-level ' +
	'field names, "all", or "default") to control what comes back — the compact view\'s ' +
	'`_omitted` list names what you can ask for. Unknown field names are rejected.';

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
// Three modes:
//   - `fields` omitted   → compact default: project to the `keep` allowlist and
//                          report dropped non-empty field names in `omitted`.
//   - `fields === "all"` → return the input untouched with an empty `omitted`.
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
	if (selector === 'all') return { value: input, omitted: [] };
	const explicit = selector !== undefined;
	if (explicit && opts.validate !== false) {
		assertFieldsKnown(selector as readonly string[], [{ input, keep: opts.keep }]);
	}
	const keep = new Set(explicit ? (selector as readonly string[]) : opts.keep);
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
	if (selector === undefined || selector === 'all') return;
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
// originate from any of the combined shapes; the model cannot tell which, but
// `fields:"all"` recovers every shape in full, so the ambiguity is harmless.
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
