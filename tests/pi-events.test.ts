import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiEventMapper } from '../src/lib/server/pi/events';

const MESSAGE_ID = 'msg-test-1';

// Minimal structurally-typed AgentSessionEvent fixtures: the mapper only reads
// the discriminated `type` and the fields asserted below.
function event(partial: unknown): AgentSessionEvent {
	return partial as AgentSessionEvent;
}

describe('PiEventMapper', () => {
	it('maps message_start / text_delta / message_end to portal events', () => {
		const mapper = new PiEventMapper(MESSAGE_ID);
		expect(mapper.map(event({ type: 'message_start', message: {} }))).toEqual([
			{ type: 'message.start', messageId: MESSAGE_ID, role: 'assistant' }
		]);
		expect(
			mapper.map(
				event({
					type: 'message_update',
					message: {},
					assistantMessageEvent: {
						type: 'text_delta',
						contentIndex: 0,
						delta: 'Hello',
						partial: {}
					}
				})
			)
		).toEqual([{ type: 'message.delta', messageId: MESSAGE_ID, text: 'Hello' }]);
		expect(mapper.map(event({ type: 'message_end', message: {} }))).toEqual([
			{ type: 'message.end', messageId: MESSAGE_ID }
		]);
		expect(mapper.ended).toBe(true);
	});

	it('keeps one reasoning segment per thinking block across deltas', () => {
		const mapper = new PiEventMapper(MESSAGE_ID);
		const first = mapper.map(
			event({
				type: 'message_update',
				message: {},
				assistantMessageEvent: {
					type: 'thinking_delta',
					contentIndex: 0,
					delta: 'think',
					partial: {}
				}
			})
		);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ type: 'message.reasoning', text: 'think' });
		const segmentId = (first[0] as { type: 'message.reasoning'; segmentId: string }).segmentId;

		const second = mapper.map(
			event({
				type: 'message_update',
				message: {},
				assistantMessageEvent: {
					type: 'thinking_delta',
					contentIndex: 0,
					delta: ' more',
					partial: {}
				}
			})
		);
		expect((second[0] as { type: 'message.reasoning'; segmentId: string }).segmentId).toBe(
			segmentId
		);

		const closed = mapper.map(
			event({
				type: 'message_update',
				message: {},
				assistantMessageEvent: {
					type: 'thinking_end',
					contentIndex: 0,
					content: 'think more',
					partial: {}
				}
			})
		);
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({
			type: 'message.reasoning.end',
			segmentId,
			durationMs: expect.any(Number)
		});
	});

	it('closes dangling reasoning bursts on run end', () => {
		const mapper = new PiEventMapper(MESSAGE_ID);
		mapper.map(
			event({
				type: 'message_update',
				message: {},
				assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'x', partial: {} }
			})
		);
		const closed = mapper.closeReasoning();
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({ type: 'message.reasoning.end' });
		expect(mapper.closeReasoning()).toHaveLength(0);
	});

	it('surfaces stream errors once', () => {
		const mapper = new PiEventMapper(MESSAGE_ID);
		const out = mapper.map(
			event({
				type: 'message_update',
				message: {},
				assistantMessageEvent: {
					type: 'error',
					reason: 'error',
					error: { errorMessage: 'boom' }
				}
			})
		);
		expect(out).toEqual([{ type: 'error', code: 'pi_stream_error', message: 'boom' }]);
		expect(mapper.hasError).toBe(true);
	});

	it('maps tool executions to tool.call / tool.result', () => {
		const mapper = new PiEventMapper(MESSAGE_ID);
		expect(
			mapper.map(
				event({
					type: 'tool_execution_start',
					toolCallId: 't1',
					toolName: 'read',
					args: { path: 'a' }
				})
			)
		).toEqual([
			{
				type: 'tool.call',
				toolCallId: 't1',
				tool: 'read',
				args: { path: 'a' },
				messageId: MESSAGE_ID
			}
		]);
		expect(
			mapper.map(
				event({
					type: 'tool_execution_end',
					toolCallId: 't1',
					toolName: 'read',
					result: { content: [{ type: 'text', text: 'file body' }] },
					isError: false
				})
			)
		).toEqual([{ type: 'tool.result', toolCallId: 't1', ok: true, summary: 'file body' }]);
	});
});
