import { describe, it, expect } from 'vitest';
import { FixedWindowRateLimiter } from '../src/lib/server/rate-limit';

describe('FixedWindowRateLimiter', () => {
	it('does not limit a fresh key and reports zero retry', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 3 });
		expect(rl.check('a', 0)).toEqual({ limited: false, retryAfterMs: 0 });
	});

	it('limits only once recorded hits reach max within the window', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 3 });
		rl.record('a', 0);
		rl.record('a', 10);
		expect(rl.check('a', 20).limited).toBe(false);
		rl.record('a', 20);
		// Third hit reaches max=3; now over limit.
		const res = rl.check('a', 30);
		expect(res.limited).toBe(true);
		// retryAfterMs counts down to the window reset (0 + 1000).
		expect(res.retryAfterMs).toBe(970);
	});

	it('opens a fresh window once the previous one elapses', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
		rl.record('a', 0);
		expect(rl.check('a', 500).limited).toBe(true);
		// At resetAt the bucket is considered expired (now >= resetAt).
		expect(rl.check('a', 1000).limited).toBe(false);
		// Recording after expiry starts a new window rather than stacking.
		rl.record('a', 1000);
		expect(rl.check('a', 1500).limited).toBe(true);
		expect(rl.check('a', 1500).retryAfterMs).toBe(500);
	});

	it('keeps separate windows per key', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
		rl.record('a', 0);
		expect(rl.check('a', 100).limited).toBe(true);
		expect(rl.check('b', 100).limited).toBe(false);
		rl.record('b', 100);
		expect(rl.check('b', 100).limited).toBe(true);
		// 'a' is unaffected by 'b'.
		expect(rl.check('a', 100).limited).toBe(true);
	});

	it('reset clears recorded state for a key', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
		rl.record('a', 0);
		expect(rl.check('a', 0).limited).toBe(true);
		rl.reset('a');
		expect(rl.check('a', 0).limited).toBe(false);
		// A post-reset hit starts a brand new window.
		rl.record('a', 0);
		expect(rl.check('a', 0).limited).toBe(true);
	});

	it('reset of an unknown key is a no-op', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
		expect(() => rl.reset('missing')).not.toThrow();
		expect(rl.check('missing', 0).limited).toBe(false);
	});

	it('prunes expired buckets on record so the map cannot grow unbounded', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 5 });
		// Seed many keys in the first window.
		for (let i = 0; i < 100; i++) rl.record(`k${i}`, 0);
		expect(bucketCount(rl)).toBe(100);

		// A record well past the window expiry prunes every stale bucket
		// (including the new key's own slot before it is re-added).
		rl.record('fresh', 5000);
		expect(bucketCount(rl)).toBe(1);
		expect(rl.check('fresh', 5000).limited).toBe(false);
		expect(rl.check('k0', 5000).limited).toBe(false);
	});

	it('record increments an active bucket without resetting its window', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 3 });
		rl.record('a', 0);
		rl.record('a', 100);
		rl.record('a', 200);
		// resetAt is anchored to the first hit (0 + 1000), not the latest.
		expect(rl.check('a', 300)).toEqual({ limited: true, retryAfterMs: 700 });
	});

	it('treats max of zero as immediately limited after the first hit', () => {
		const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 0 });
		rl.record('a', 0);
		expect(rl.check('a', 0).limited).toBe(true);
	});
});

/** Read the private bucket map size for eviction assertions. */
function bucketCount(rl: FixedWindowRateLimiter): number {
	return (rl as unknown as { buckets: Map<string, unknown> }).buckets.size;
}
