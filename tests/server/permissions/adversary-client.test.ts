import { describe, it, expect } from 'vitest';
import {
	parseVerdict,
	reviewPermissionRequest
} from '../../../src/lib/server/permissions/adversary/client';
import { buildAdversaryFacts } from '../../../src/lib/server/permissions/adversary/prompt';

const FACTS = buildAdversaryFacts({
	tool: 'shell',
	permissionKind: 'shell',
	scopeKey: 'rm -rf /',
	args: { command: 'rm -rf /' }
});

const OPTS = { model: 'reviewer-1', timeoutMs: 1000 };

describe('parseVerdict', () => {
	it('accepts a bare JSON object', () => {
		expect(parseVerdict('{"verdict":"deny","rationale":"Destroys the filesystem."}')).toEqual({
			kind: 'verdict',
			verdict: 'deny',
			rationale: 'Destroys the filesystem.',
			denyProbability: null
		});
	});

	it('accepts a fenced JSON object with trailing prose', () => {
		const raw = '```json\n{"verdict":"allow","rationale":"Read-only."}\n```\nHope that helps!';
		expect(parseVerdict(raw)?.verdict).toBe('allow');
	});

	it('does not scan prose for verdict words', () => {
		// A model that refuses the task ("I cannot deny this without more
		// context") must not be scored as if it answered — a fabricated label
		// corrupts the only number this phase produces.
		expect(parseVerdict('I would deny this, but I need more context.')).toBeNull();
	});

	it('captures the deny probability when present', () => {
		// Recorded but unused in Phase 0 scoring; it exists so a precision/recall
		// CURVE can be computed later without re-collecting every row. It is a
		// deny probability rather than "confidence in the verdict" precisely so
		// it means the same thing regardless of which verdict was given.
		expect(
			parseVerdict('{"verdict":"deny","denyProbability":0.9,"rationale":"x"}')?.denyProbability
		).toBe(0.9);
		// Models routinely normalize JSON keys, and silently dropping the number
		// would look identical to "the model never gave one".
		expect(
			parseVerdict('{"verdict":"deny","deny_probability":0.9,"rationale":"x"}')?.denyProbability
		).toBe(0.9);
	});

	it('records a missing or nonsensical deny probability as null, never a default', () => {
		// "the model didn't say" and "the model said 0.5" are different
		// observations; inventing the second fabricates calibration data.
		expect(parseVerdict('{"verdict":"deny","rationale":"x"}')?.denyProbability).toBeNull();
		expect(
			parseVerdict('{"verdict":"deny","denyProbability":7,"rationale":"x"}')?.denyProbability
		).toBeNull();
		expect(
			parseVerdict('{"verdict":"deny","denyProbability":"high","rationale":"x"}')?.denyProbability
		).toBeNull();
		// Discarding an otherwise well-formed review because one secondary field
		// is absent would bias the primary metric to protect the secondary one.
		expect(parseVerdict('{"verdict":"deny","rationale":"x"}')?.verdict).toBe('deny');
	});

	it('rejects an unrecognised verdict, a missing rationale, and non-objects', () => {
		expect(parseVerdict('{"verdict":"maybe","rationale":"unsure"}')).toBeNull();
		expect(parseVerdict('{"verdict":"deny"}')).toBeNull();
		expect(parseVerdict('{"verdict":"deny","rationale":"   "}')).toBeNull();
		expect(parseVerdict('')).toBeNull();
		expect(parseVerdict('{ not json')).toBeNull();
		expect(parseVerdict('"deny"')).toBeNull();
		expect(parseVerdict('[1,2,3]')).toBeNull();
	});

	it('unwraps a verdict object a model wrapped in an array', () => {
		// The scan finds the first balanced object, so `[{...}]` still parses.
		// Deliberate: the object itself still had to be a strict, well-formed
		// verdict, so nothing is being invented — only unwrapped.
		expect(parseVerdict('[{"verdict":"deny","rationale":"x"}]')?.verdict).toBe('deny');
	});

	it('is not fooled by braces inside string values', () => {
		expect(parseVerdict('{"verdict":"deny","rationale":"uses ${x} and }"}')?.rationale).toBe(
			'uses ${x} and }'
		);
	});

	it('truncates a runaway rationale', () => {
		const parsed = parseVerdict(JSON.stringify({ verdict: 'deny', rationale: 'x'.repeat(5000) }));
		expect(parsed?.rationale.length).toBeLessThanOrEqual(1001);
	});
});

describe('reviewPermissionRequest', () => {
	it('returns a verdict for well-formed output', async () => {
		const outcome = await reviewPermissionRequest(FACTS, {
			...OPTS,
			complete: async () => '{"verdict":"deny","rationale":"Irreversible."}'
		});
		expect(outcome).toMatchObject({ kind: 'verdict', verdict: 'deny', rationale: 'Irreversible.' });
	});

	it('reports unparseable output as an error, never as a verdict', async () => {
		const outcome = await reviewPermissionRequest(FACTS, {
			...OPTS,
			complete: async () => 'Sure! That looks fine to me.'
		});
		expect(outcome.kind).toBe('error');
		if (outcome.kind === 'error') expect(outcome.error).toContain('unparseable');
	});

	it('reports a transport failure as an error rather than rejecting', async () => {
		const outcome = await reviewPermissionRequest(FACTS, {
			...OPTS,
			complete: async () => {
				throw new Error('ECONNREFUSED');
			}
		});
		expect(outcome).toMatchObject({ kind: 'error', error: 'ECONNREFUSED' });
	});

	it('passes the system prompt and the built user prompt to the provider', async () => {
		let seen: { system: string; user: string; model: string } | null = null;
		await reviewPermissionRequest(FACTS, {
			...OPTS,
			complete: async (req) => {
				seen = { system: req.system, user: req.user, model: req.model };
				return '{"verdict":"allow","rationale":"ok"}';
			}
		});
		expect(seen).not.toBeNull();
		expect(seen!.system).toContain('security reviewer');
		expect(seen!.user).toContain('rm -rf /');
		// The reviewer model, not the agent's: the call is dispatched by the
		// provider, so nothing downstream re-derives which model to ask.
		expect(seen!.model).toBe('reviewer-1');
	});

	it('asks for structured output so the schema travels with the request', async () => {
		let schemaName: string | null = null;
		await reviewPermissionRequest(FACTS, {
			...OPTS,
			complete: async (req) => {
				schemaName = req.responseSchema.name;
				return '{"verdict":"allow","rationale":"ok"}';
			}
		});
		expect(schemaName).toBe('permission_review');
	});
});
