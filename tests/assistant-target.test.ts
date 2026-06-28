import { describe, expect, it } from 'vitest';
import { resolveAssistantTarget } from '../src/lib/client/assistant-target';
import type { Role } from '../src/lib/types';

type Msg = { id: string; role: Role };

const m = (id: string, role: Role): Msg => ({ id, role });

describe('resolveAssistantTarget', () => {
	it('targets the assistant message matching the event messageId', () => {
		const messages = [m('u1', 'user'), m('a1', 'assistant'), m('a2', 'assistant')];
		expect(resolveAssistantTarget(messages, 'a1')).toEqual({ kind: 'found', index: 1 });
	});

	it('refreshes when the messageId is not present locally (reconnect gap)', () => {
		const messages = [m('u1', 'user'), m('a1', 'assistant')];
		// The card arrived before its assistant message was fetched — re-sync.
		expect(resolveAssistantTarget(messages, 'a-missing')).toEqual({ kind: 'refresh' });
	});

	it('refreshes when the messageId resolves to a non-assistant message', () => {
		const messages = [m('u1', 'user'), m('a1', 'assistant')];
		expect(resolveAssistantTarget(messages, 'u1')).toEqual({ kind: 'refresh' });
	});

	it('falls back to the last message when no messageId is provided', () => {
		const messages = [m('u1', 'user'), m('a1', 'assistant')];
		expect(resolveAssistantTarget(messages, undefined)).toEqual({ kind: 'found', index: 1 });
	});

	it('refreshes when no messageId is provided and the last message is not an assistant', () => {
		const messages = [m('a1', 'assistant'), m('u2', 'user')];
		expect(resolveAssistantTarget(messages, undefined)).toEqual({ kind: 'refresh' });
	});

	it('refreshes on an empty thread', () => {
		expect(resolveAssistantTarget([], undefined)).toEqual({ kind: 'refresh' });
		expect(resolveAssistantTarget([], 'a1')).toEqual({ kind: 'refresh' });
	});
});
