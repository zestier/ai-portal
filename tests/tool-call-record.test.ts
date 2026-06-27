import { describe, expect, it } from 'vitest';
import { findToolCallRecord } from '../src/lib/client/tool-call-record';
import type { Message, ToolCallRecord } from '../src/lib/types';

function toolCall(id: string, tool: string): ToolCallRecord {
	return {
		id,
		messageId: 'message-1',
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

function message(id: string, toolCalls: ToolCallRecord[] = []): Pick<Message, 'toolCalls'> {
	return { toolCalls: toolCalls.map((tc) => ({ ...tc, messageId: id })) };
}

describe('findToolCallRecord', () => {
	it('finds tool calls across prior messages', () => {
		const ticketUpdate = toolCall('ticket-update-1', 'ticket_update');
		const messages = [
			message('message-1', [ticketUpdate]),
			message('message-2', [toolCall('bash-1', 'bash')])
		];

		expect(findToolCallRecord(messages, 'ticket-update-1')?.tool).toBe('ticket_update');
	});

	it('returns undefined when no record matches', () => {
		const messages = [message('message-1', [toolCall('bash-1', 'bash')])];
		expect(findToolCallRecord(messages, 'missing')).toBeUndefined();
	});
});
