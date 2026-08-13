import { describe, expect, it } from 'vitest';
import { resolveAssistantTarget } from '../src/lib/client/assistant-target';
import { messageId } from '../src/lib/ids';
import type { Role } from '../src/lib/types';

type Msg = { id: string; role: Role };

const m = (id: number, role: Role): Msg => ({ id: messageId.encode(id), role });

describe('resolveAssistantTarget', () => {
	it('targets the assistant message matching the event messageId', () => {
		const messages = [m(1, 'user'), m(2, 'assistant'), m(3, 'assistant')];
		expect(resolveAssistantTarget(messages, messageId.encode(2))).toEqual({
			kind: 'found',
			index: 1
		});
	});

	it('refreshes when the messageId is not present locally (reconnect gap)', () => {
		const messages = [m(1, 'user'), m(2, 'assistant')];
		// The card arrived before its assistant message was fetched — re-sync.
		expect(resolveAssistantTarget(messages, messageId.encode(99))).toEqual({ kind: 'refresh' });
	});

	it('refreshes when the messageId resolves to a non-assistant message', () => {
		const messages = [m(1, 'user'), m(2, 'assistant')];
		expect(resolveAssistantTarget(messages, messageId.encode(1))).toEqual({ kind: 'refresh' });
	});

	it('falls back to the last message when no messageId is provided', () => {
		const messages = [m(1, 'user'), m(2, 'assistant')];
		expect(resolveAssistantTarget(messages, undefined)).toEqual({ kind: 'found', index: 1 });
	});

	it('refreshes when no messageId is provided and the last message is not an assistant', () => {
		const messages = [m(2, 'assistant'), m(4, 'user')];
		expect(resolveAssistantTarget(messages, undefined)).toEqual({ kind: 'refresh' });
	});

	it('refreshes on an empty thread', () => {
		expect(resolveAssistantTarget([], undefined)).toEqual({ kind: 'refresh' });
		expect(resolveAssistantTarget([], messageId.encode(2))).toEqual({ kind: 'refresh' });
	});
});
