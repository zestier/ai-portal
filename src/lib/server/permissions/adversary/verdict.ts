/**
 * Strict parsing of the adversary's reply. Pure and import-free so the offline
 * probe script (`scripts/adversary-probe.mjs`) can load it directly.
 *
 * The strictness is the point. Anything that is not a well-formed
 * `{verdict, rationale}` object returns `null` and is recorded as an error —
 * never coerced into a verdict. A fabricated "allow" would silently inflate
 * agreement and a fabricated "deny" would inflate recall; either corrupts the
 * only number Phase 0 produces.
 */

export type AdversaryVerdictWord = 'allow' | 'deny';

export interface ParsedVerdict {
	kind: 'verdict';
	verdict: AdversaryVerdictWord;
	rationale: string;
	/**
	 * The model's estimated probability that a careful operator would REJECT
	 * this request, in [0,1], or `null` when it did not supply a usable one.
	 *
	 * Deliberately a deny probability rather than "confidence in the verdict":
	 * the latter changes meaning depending on which verdict was given, so
	 * turning it into a single sweepable score needs a signed conversion and
	 * becomes incoherent below 0.5.
	 *
	 * Recorded but NOT used for scoring in Phase 0. It exists so a later
	 * analysis can compute a precision/recall *curve* by sweeping a threshold,
	 * rather than being stuck with the single arbitrary operating point a bare
	 * binary verdict gives. Adding it later would mean re-collecting every row.
	 * It is self-reported and uncalibrated — a ranking signal, not a
	 * probability. The readout prints how often it is actually present, because
	 * a collection of nulls means the curve does not exist.
	 */
	denyProbability: number | null;
}

export const MAX_RATIONALE_CHARS = 1000;

/**
 * Accepts a bare JSON object or one wrapped in a fenced code block (small
 * models fence habitually), and nothing else. In particular it does NOT scan
 * prose for the words "allow"/"deny", so a model that refused the task is not
 * scored as if it had answered.
 */
export function parseVerdict(raw: string): ParsedVerdict | null {
	if (typeof raw !== 'string') return null;
	const json = extractJsonObject(raw);
	if (!json) return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const row = value as {
		verdict?: unknown;
		rationale?: unknown;
		denyProbability?: unknown;
		deny_probability?: unknown;
	};
	if (row.verdict !== 'allow' && row.verdict !== 'deny') return null;
	const rationale = typeof row.rationale === 'string' ? row.rationale.trim() : '';
	if (rationale.length === 0) return null;
	return {
		kind: 'verdict',
		verdict: row.verdict,
		rationale:
			rationale.length > MAX_RATIONALE_CHARS
				? `${rationale.slice(0, MAX_RATIONALE_CHARS)}…`
				: rationale,
		// Accept snake_case too: the field is requested in camelCase but models
		// routinely normalize JSON keys, and silently discarding the number
		// would look identical to "the model never gave one".
		denyProbability: normalizeProbability(row.denyProbability ?? row.deny_probability)
	};
}

/**
 * A missing or out-of-range value is recorded as `null` rather than clamped or
 * defaulted: "the model didn't say" and "the model said 0.5" are different
 * observations, and inventing the second would quietly fabricate calibration
 * data. A verdict is still returned — throwing away an otherwise well-formed
 * review because one optional field is absent would bias the primary metric to
 * protect a secondary one.
 */
function normalizeProbability(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (value < 0 || value > 1) return null;
	return value;
}

/** First balanced `{...}` object in the text, string- and escape-aware. */
function extractJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced?.[1] ?? text;
	const start = candidate.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < candidate.length; i++) {
		const char = candidate[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) return candidate.slice(start, i + 1);
		}
	}
	return null;
}
