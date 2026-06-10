import { describe, it, expect } from 'vitest';
import { deriveEnvelopeSummary, envelopePayloadText, err, ok } from '../src/lib/server/tools/types';

describe('deriveEnvelopeSummary', () => {
	it('prefers an explicit summary, trimmed', () => {
		expect(deriveEnvelopeSummary(ok({ results: [] }, '  3 result(s)  '))).toBe('3 result(s)');
	});

	it('derives a single-line snippet from an object result when no summary is set', () => {
		expect(deriveEnvelopeSummary(ok({ a: 1 }))).toBe('{"a":1}');
	});

	it('uses the raw string for a string result', () => {
		expect(deriveEnvelopeSummary(ok('plain text'))).toBe('plain text');
	});

	it('reports an empty result rather than the envelope JSON', () => {
		expect(deriveEnvelopeSummary(ok())).toBe('(empty result)');
	});

	it('derives the error message for failures', () => {
		expect(deriveEnvelopeSummary(err('nothing to commit'))).toBe('nothing to commit');
	});

	it('caps long payloads to a single 200-char line', () => {
		const long = 'x'.repeat(500);
		const summary = deriveEnvelopeSummary(ok(long));
		expect(summary.length).toBe(200);
		expect(summary.endsWith('...')).toBe(true);
	});

	it('exposes the underlying payload text for both variants', () => {
		expect(envelopePayloadText(ok({ a: 1 }))).toBe('{"a":1}');
		expect(envelopePayloadText(err('boom'))).toBe('boom');
	});
});
