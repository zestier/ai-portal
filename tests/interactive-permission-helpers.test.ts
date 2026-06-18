import { describe, it, expect } from 'vitest';
import { expiryChoiceToMs } from '../src/lib/components/interactive-permission';

// Shared TTL mapping used by both permission dialogs (InteractivePermissionRequest
// and InteractiveGrantRequest) when emitting an *-always grant's `expiresInMs`.

describe('expiryChoiceToMs', () => {
	it('maps 1h to one hour in milliseconds', () => {
		expect(expiryChoiceToMs('1h')).toBe(60 * 60 * 1000);
	});

	it('maps 1d to one day in milliseconds', () => {
		expect(expiryChoiceToMs('1d')).toBe(24 * 60 * 60 * 1000);
	});

	it('maps forever to undefined (never expires)', () => {
		expect(expiryChoiceToMs('forever')).toBeUndefined();
	});
});
