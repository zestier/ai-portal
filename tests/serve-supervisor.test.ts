import { describe, expect, it } from 'vitest';
import { restartDelayMs, shouldRollback } from '../scripts/lib/serve-supervisor.mjs';

describe('shouldRollback', () => {
	const thresholdMs = 5000;

	it('rolls back on an early non-zero exit when a previous tree exists', () => {
		expect(shouldRollback({ code: 1, uptimeMs: 800, hasPrev: true, thresholdMs })).toBe(true);
	});

	it('does not roll back without a previous tree to restore', () => {
		expect(shouldRollback({ code: 1, uptimeMs: 800, hasPrev: false, thresholdMs })).toBe(false);
	});

	it('does not roll back a clean exit (the redeploy self-restart)', () => {
		expect(shouldRollback({ code: 0, uptimeMs: 10, hasPrev: true, thresholdMs })).toBe(false);
	});

	it('does not roll back a signal kill (code === null)', () => {
		// A SIGTERM/SIGKILL surfaces as code === null; that is an operator action,
		// not a crash-loop, so the live tree must be left in place.
		expect(shouldRollback({ code: null, uptimeMs: 5, hasPrev: true, thresholdMs })).toBe(false);
	});

	it('does not roll back a non-zero exit that happened after the threshold', () => {
		// A long-lived process that later crashes is not the bad-build signature
		// rollback targets — the running tree was clearly viable for a while.
		expect(shouldRollback({ code: 1, uptimeMs: 60_000, hasPrev: true, thresholdMs })).toBe(false);
	});

	it('treats the threshold as exclusive (uptime exactly at the cutoff is not a crash-loop)', () => {
		expect(shouldRollback({ code: 1, uptimeMs: thresholdMs, hasPrev: true, thresholdMs })).toBe(
			false
		);
	});
});

describe('restartDelayMs', () => {
	it('restarts almost immediately after a clean rollover exit', () => {
		expect(restartDelayMs(0)).toBe(250);
	});

	it('backs off after a crash so a persistent failure does not busy-loop', () => {
		expect(restartDelayMs(1)).toBe(2000);
		expect(restartDelayMs(null)).toBe(2000);
	});
});
