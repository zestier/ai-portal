import { describe, it, expect } from 'vitest';
import {
	expiryChoiceToMs,
	resolvePermissionShortcut,
	type PermissionShortcutState
} from '../../src/lib/components/interactive-permission';

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

// Security-critical: gates Enter-to-approve in the permission dialog so a
// buffered / auto-repeating Enter (e.g. left over from the keystroke that sent
// the message which triggered the prompt) can't silently allow a request, while
// Escape (deny — the safe direction) is always honored.
describe('resolvePermissionShortcut', () => {
	const ready: PermissionShortcutState = {
		busy: false,
		focusOnDialog: true,
		approveArmed: true,
		canPersistDecision: true,
		denyAllPolicy: false
	};
	const ev = (over: Partial<{ key: string; shiftKey: boolean; repeat: boolean }> = {}) => ({
		key: 'Enter',
		shiftKey: false,
		repeat: false,
		...over
	});

	it('approves once on a plain armed Enter with the dialog focused', () => {
		expect(resolvePermissionShortcut(ev(), ready)).toBe('allow-once');
	});

	it('persists on armed Shift+Enter when a persistent decision is offered', () => {
		expect(resolvePermissionShortcut(ev({ shiftKey: true }), ready)).toBe('allow-always');
	});

	it('ignores an auto-repeating Enter so a held key cannot approve', () => {
		expect(resolvePermissionShortcut(ev({ repeat: true }), ready)).toBe('none');
	});

	it('ignores Enter until the approve shortcuts are armed', () => {
		expect(resolvePermissionShortcut(ev(), { ...ready, approveArmed: false })).toBe('none');
	});

	it('ignores Enter while focus is on an inner control (e.g. feedback textarea)', () => {
		expect(resolvePermissionShortcut(ev(), { ...ready, focusOnDialog: false })).toBe('none');
	});

	it('ignores every key while a response is in flight', () => {
		expect(resolvePermissionShortcut(ev({ key: 'Escape' }), { ...ready, busy: true })).toBe('none');
		expect(resolvePermissionShortcut(ev(), { ...ready, busy: true })).toBe('none');
	});

	it('downgrades Shift+Enter to none when persistence is unavailable', () => {
		expect(
			resolvePermissionShortcut(ev({ shiftKey: true }), { ...ready, canPersistDecision: false })
		).toBe('none');
	});

	it('never reaches allow-always under a deny-all policy', () => {
		expect(
			resolvePermissionShortcut(ev({ shiftKey: true }), { ...ready, denyAllPolicy: true })
		).toBe('none');
	});

	it('always denies on Escape immediately — even unarmed, repeating, or mid-typing', () => {
		const esc = ev({ key: 'Escape' });
		expect(resolvePermissionShortcut(esc, ready)).toBe('deny');
		expect(resolvePermissionShortcut(esc, { ...ready, approveArmed: false })).toBe('deny');
		expect(resolvePermissionShortcut({ ...esc, repeat: true }, ready)).toBe('deny');
		expect(resolvePermissionShortcut(esc, { ...ready, focusOnDialog: false })).toBe('deny');
	});

	it('ignores unrelated keys', () => {
		expect(resolvePermissionShortcut(ev({ key: 'a' }), ready)).toBe('none');
	});
});
