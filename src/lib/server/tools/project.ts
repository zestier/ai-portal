// Compact-by-default projection for tool results. Portal `ToolResult` envelopes
// are serialized verbatim into the model's context (see `types.ts`), so every
// field a handler returns costs tokens. `project` trims a domain record (or
// array of records) down to an explicit per-shape allowlist of model-relevant
// fields, dropping the rest along with any null/undefined/empty values.
//
// The default is intentionally the lean shape: models are unreliable at opting
// into savings, so handlers project by default and expose an opt-in
// `verbose: true` argument that returns the full, unprojected payload.
//
// Allowlists (not blacklists) are deliberate: they age better as schemas grow,
// since a newly added noisy field is dropped automatically rather than leaking
// until someone remembers to blacklist it.

export interface Projection<T> {
	value: T;
	// Field names that carried information but were dropped from the compact
	// shape, sorted and de-duplicated. Empty/null/blank fields are NOT listed:
	// re-fetching them via `verbose` would yield nothing, so surfacing them would
	// be noise and could provoke pointless verbose re-calls. This list is purely
	// descriptive metadata — a passive escape hatch, not an instruction.
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
			// are truly absent (re-fetching them via verbose would yield nothing).
			if (isAbsentValue(value)) continue;
			out[key] = value;
		} else {
			if (isEmptyValue(value)) continue; // no information lost; never list it
			dropped.add(key);
		}
	}
	return out;
}

// Project a record or array of records to the `keep` allowlist. When `verbose`
// is set the input is returned untouched with an empty `omitted` list. Non-object
// inputs (and non-object array elements) pass through unchanged.
export function project<T>(
	input: T,
	opts: { verbose?: boolean; keep: readonly string[] }
): Projection<T> {
	if (opts.verbose) return { value: input, omitted: [] };
	const keep = new Set(opts.keep);
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
	return { value: value as T, omitted: [...dropped].sort() };
}

// Union the `omitted` lists of several projections into one sorted, de-duplicated
// list — used by handlers that project multiple shapes into a single result.
// Note: attribution is intentionally collapsed. A name like `conversationId` may
// originate from any of the combined shapes; the model cannot tell which, but
// `verbose:true` recovers every shape in full, so the ambiguity is harmless.
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
