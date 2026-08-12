import { describe, expect, it } from 'vitest';
import { findToolCallRecord } from '../src/lib/client/tool-call-record';
import type { Message, ToolCallRecord } from '../src/lib/types';

function toolCall(id: number, tool: string): ToolCallRecord {
	return {
		id,
		messageId: 1,
		tool,
		argsJson: '{}',
		resultJson: null,
		status: 'pending',
		startedAt: 1,
		endedAt: null,
		textOffset: null,
		parentToolCallId: null
	};
}

function message(id: number, toolCalls: ToolCallRecord[] = []): Pick<Message, 'toolCalls'> {
	return { toolCalls: toolCalls.map((tc) => ({ ...tc, messageId: id })) };
}

describe('findToolCallRecord', () => {
	it('finds tool calls across prior messages', () => {
		const ticketUpdate = toolCall(1, 'ticket_update');
		const messages = [message(1, [ticketUpdate]), message(2, [toolCall(2, 'bash')])];

		expect(findToolCallRecord(messages, 1)?.tool).toBe('ticket_update');
	});

	it('returns undefined when no record matches', () => {
		const messages = [message(1, [toolCall(2, 'bash')])];
		expect(findToolCallRecord(messages, 999999)).toBeUndefined();
	});
});
