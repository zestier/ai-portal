import { describe, expect, test } from 'vitest';
import { createConversationResetGate } from '../src/lib/client/conversation-reset';

// Regression coverage for the bug where a background `invalidateAll()` /
// `load` re-run wiped the user's unsent composer draft. The conversation page
// hands `<Chat>` a brand-new `data.conversation` object on every refresh; the
// reset must key on the id *value*, not the prop object identity, so a refresh
// of the *same* conversation leaves local state (composer draft, message list,
// usage, interactive queue, scroll pin) untouched.
describe('createConversationResetGate', () => {
	test('seeds state on first run (no previously-seen id)', () => {
		const gate = createConversationResetGate();
		expect(gate.shouldReset('conv-1')).toBe(true);
	});

	test('same id, new prop object → no reset (composer + messages preserved)', () => {
		// This is the bug: a refresh produces a fresh prop object with the same
		// id. The reset must be skipped so the in-progress draft survives.
		const gate = createConversationResetGate();
		gate.shouldReset('conv-1');
		expect(gate.shouldReset('conv-1')).toBe(false);
	});

	test('repeated same-id refreshes never reset (gate records the seeded id)', () => {
		// Guards the footgun of reading the id but forgetting to record it: a
		// gate that didn't remember the last id would reset on the *second*
		// refresh and still wipe the draft.
		const gate = createConversationResetGate();
		expect(gate.shouldReset('conv-1')).toBe(true);
		expect(gate.shouldReset('conv-1')).toBe(false);
		expect(gate.shouldReset('conv-1')).toBe(false);
	});

	test('new id → reset (genuine conversation switch)', () => {
		const gate = createConversationResetGate();
		gate.shouldReset('conv-1');
		expect(gate.shouldReset('conv-2')).toBe(true);
	});

	test('switching away and back resets each time the id actually changes', () => {
		const gate = createConversationResetGate();
		expect(gate.shouldReset('conv-1')).toBe(true);
		expect(gate.shouldReset('conv-2')).toBe(true);
		expect(gate.shouldReset('conv-2')).toBe(false);
		expect(gate.shouldReset('conv-1')).toBe(true);
	});
});
