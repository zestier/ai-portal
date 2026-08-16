import { describe, it, expect } from 'vitest';
import {
	scoreShadowDecisions,
	type HumanPermissionDecision,
	type ShadowScoringRow
} from '../../../src/lib/server/permissions/adversary/scoring';
import type { InteractivePermissionDecision } from '../../../src/lib/types';

// Compile-time guard: `scoring.ts` is deliberately dependency-free (the offline
// report script imports it directly), so it redeclares the human-decision
// vocabulary instead of importing `$lib/types`. This assignment fails to
// typecheck if the two ever drift apart.
const _vocabularyMatches: HumanPermissionDecision = null as InteractivePermissionDecision | null;
void _vocabularyMatches;

const row = (
	verdict: 'allow' | 'deny' | null,
	humanDecision: HumanPermissionDecision,
	status: ShadowScoringRow['status'] = 'verdict'
): ShadowScoringRow => ({ status, verdict, humanDecision });

const memoizedRow = (
	verdict: 'allow' | 'deny' | null,
	humanDecision: HumanPermissionDecision
): ShadowScoringRow => ({ status: 'verdict', verdict, humanDecision, memoized: true });

describe('scoreShadowDecisions', () => {
	it('computes deny precision and recall against human denies', () => {
		const score = scoreShadowDecisions([
			row('deny', 'deny'), // TP
			row('deny', 'deny-always'), // TP
			row('deny', 'allow-once'), // FP
			row('allow', 'deny'), // FN
			row('allow', 'allow-always') // TN
		]);
		expect(score).toMatchObject({
			scored: 5,
			truePositives: 2,
			falsePositives: 1,
			falseNegatives: 1,
			trueNegatives: 1
		});
		expect(score.denyPrecision).toBeCloseTo(2 / 3);
		expect(score.denyRecall).toBeCloseTo(2 / 3);
		expect(score.denyF1).toBeCloseTo(2 / 3);
		expect(score.agreement).toBeCloseTo(3 / 5);
		expect(score.humanDenyRate).toBeCloseTo(3 / 5);
	});

	it('excludes rows with no human label rather than counting them as denials', () => {
		// A cancelled/expired prompt is explicitly NOT a denial (see
		// `interactive-requests.cancel`). Counting it as one would inflate the
		// human deny base rate and hand the adversary free recall.
		const score = scoreShadowDecisions([
			row('deny', null),
			row('allow', null),
			row('deny', 'deny')
		]);
		expect(score.total).toBe(3);
		expect(score.excludedNoHumanLabel).toBe(2);
		expect(score.scored).toBe(1);
		expect(score.denyRecall).toBe(1);
	});

	it('excludes error and pending rows', () => {
		const score = scoreShadowDecisions([
			row(null, 'deny', 'error'),
			row(null, null, 'pending'),
			row('allow', 'allow-once')
		]);
		expect(score).toMatchObject({ errors: 1, pending: 1, scored: 1 });
	});

	it('treats a verdict-status row with no verdict as an error, not a class', () => {
		const score = scoreShadowDecisions([row(null, 'deny', 'verdict')]);
		expect(score).toMatchObject({ errors: 1, scored: 0 });
	});

	it('separates rows nobody was asked about from prompts a human abandoned', () => {
		// An `auto-approve` row can never carry a label — nobody was asked — so
		// counting it as "no human label" (a data-quality signal) or against
		// coverage would raise a false alarm about a perfectly healthy
		// collection. Same estimand mistake as counting memoized replays.
		const abandoned: ShadowScoringRow = {
			status: 'verdict',
			verdict: 'deny',
			humanDecision: null,
			resolutionSource: 'prompt-policy'
		};
		const neverAsked: ShadowScoringRow = {
			status: 'verdict',
			verdict: 'deny',
			humanDecision: null,
			resolutionSource: 'auto-approve'
		};
		const score = scoreShadowDecisions([
			{ ...row('deny', 'deny'), resolutionSource: 'prompt-policy' },
			abandoned,
			neverAsked,
			neverAsked
		]);
		expect(score).toMatchObject({
			total: 4,
			scored: 1,
			excludedNoHumanLabel: 1,
			unlabellableByDesign: 2
		});
		// Denominator is scored + abandoned, not all four.
		expect(score.coverage).toBeCloseTo(1 / 2);
	});

	it('still counts adversary errors on rows nobody was asked about', () => {
		// Those are real provider calls; their reliability is worth knowing even
		// though the verdict can never be scored. But they must still leave the
		// coverage denominator — otherwise an auto-approve-heavy deployment with
		// a normal error rate looks like a badly truncated collection.
		const score = scoreShadowDecisions([
			{ ...row('deny', 'deny'), resolutionSource: 'prompt-policy' },
			{ status: 'error', verdict: null, humanDecision: null, resolutionSource: 'auto-approve' },
			{ status: 'pending', verdict: null, humanDecision: null, resolutionSource: 'auto-approve' }
		]);
		expect(score).toMatchObject({ errors: 1, pending: 1, unlabellableByDesign: 0, scored: 1 });
		// Denominator is the one labellable row, not all three.
		expect(score.coverage).toBe(1);
	});

	it('excludes memoized replays so a retry loop cannot vote twice', () => {
		// A memoized row is the same provider call recorded again. Counting it
		// would let one agent retry loop dominate the denominators that decide
		// whether this mode ships.
		const rows = [row('deny', 'deny'), memoizedRow('deny', 'deny'), memoizedRow('deny', 'deny')];
		const headline = scoreShadowDecisions(rows);
		expect(headline).toMatchObject({ total: 3, scored: 1, memoizedDuplicates: 2 });
		expect(headline.truePositives).toBe(1);

		// The event-weighted view is available, but only as a deliberate opt-in.
		const eventWeighted = scoreShadowDecisions(rows, { includeMemoized: true });
		expect(eventWeighted).toMatchObject({ scored: 3, truePositives: 3, memoizedDuplicates: 0 });
	});

	it('reports coverage so a tiny scored slice is not mistaken for the whole', () => {
		const score = scoreShadowDecisions([
			row('deny', 'deny'),
			row('allow', null),
			row(null, 'deny', 'error'),
			row(null, null, 'pending')
		]);
		expect(score.coverage).toBeCloseTo(0.25);
		expect(scoreShadowDecisions([]).coverage).toBeNull();
	});

	it('returns null — not zero — for ratios with an empty denominator', () => {
		// "The adversary denied nothing" and "the adversary was 0% precise" are
		// different claims; reporting 0 for the first would be a lie.
		const noDenies = scoreShadowDecisions([row('allow', 'allow-once')]);
		expect(noDenies.denyPrecision).toBeNull();
		expect(noDenies.denyRecall).toBeNull();
		expect(noDenies.denyF1).toBeNull();

		const empty = scoreShadowDecisions([]);
		expect(empty).toMatchObject({
			total: 0,
			scored: 0,
			agreement: null,
			humanDenyRate: null
		});
	});

	it('exposes the trap: a yes-man scores high agreement and zero recall', () => {
		const rows: ShadowScoringRow[] = [];
		for (let i = 0; i < 19; i++) rows.push(row('allow', 'allow-once'));
		rows.push(row('allow', 'deny'));
		const score = scoreShadowDecisions(rows);
		expect(score.agreement).toBeCloseTo(0.95);
		expect(score.denyRecall).toBe(0);
		// Which is exactly the "always allow" baseline, i.e. it learned nothing.
		expect(score.agreement).toBeCloseTo(1 - (score.humanDenyRate ?? 0));
	});
});
