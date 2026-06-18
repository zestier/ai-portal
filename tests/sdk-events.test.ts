import { describe, expect, it } from 'vitest';
import { SdkEventAdapter } from '../src/lib/server/copilot/sdk-events';
import type { AsyncQueue } from '../src/lib/server/runtime/async-queue';
import type { PortalEvent, SessionMode } from '../src/lib/types';

class FakeSdkSource {
	readonly handlers = new Map<string, (e: unknown) => void>();

	on(event: string, listener: (e: unknown) => void) {
		this.handlers.set(event, listener);
	}

	emit(event: string, payload: unknown) {
		this.handlers.get(event)?.(payload);
	}
}

function makeHarness() {
	const source = new FakeSdkSource();
	const events: PortalEvent[] = [];
	const subagentLifecycleEvents: Array<{
		toolCallId: string;
		agentId: string;
		status: 'running' | 'completed' | 'failed';
	}> = [];
	let ended = false;
	let mode: SessionMode = 'interactive';
	let queue: AsyncQueue<PortalEvent> | null = {
		push(ev: PortalEvent) {
			events.push(ev);
		},
		end() {
			ended = true;
		}
	} as AsyncQueue<PortalEvent>;
	const adapter = new SdkEventAdapter({
		conversationId: 'conv-1',
		getQueue: () => queue,
		setQueue: (next) => {
			queue = next;
		},
		getMode: () => mode,
		setMode: (next) => {
			mode = next;
		},
		onSubagentLifecycle: (ev) => {
			subagentLifecycleEvents.push(ev);
		}
	});
	adapter.attach(source);
	return {
		source,
		events,
		get ended() {
			return ended;
		},
		get mode() {
			return mode;
		},
		get queue() {
			return queue;
		},
		subagentLifecycleEvents
	};
}

describe('SdkEventAdapter subagent lifecycle', () => {
	it('emits and reports started/completed/failed lifecycle events', () => {
		const h = makeHarness();

		h.source.emit('subagent.started', {
			agentId: 'agent-1',
			data: { toolCallId: 'tool-1' }
		});
		h.source.emit('subagent.completed', { agentId: 'agent-1' });
		h.source.emit('subagent.started', {
			agentId: 'agent-2',
			data: { toolCallId: 'tool-2' }
		});
		h.source.emit('subagent.failed', { agentId: 'agent-2' });

		const expected = [
			{ toolCallId: 'tool-1', agentId: 'agent-1', status: 'running' },
			{ toolCallId: 'tool-1', agentId: 'agent-1', status: 'completed' },
			{ toolCallId: 'tool-2', agentId: 'agent-2', status: 'running' },
			{ toolCallId: 'tool-2', agentId: 'agent-2', status: 'failed' }
		];
		expect(h.subagentLifecycleEvents).toEqual(expected);
		expect(h.events.filter((e) => e.type === 'subagent.lifecycle')).toEqual(
			expected.map((e) => ({ type: 'subagent.lifecycle', ...e }))
		);
	});

	it('threads a sub-agent spoken content as a child message.delta, interleaved with its reasoning', () => {
		const h = makeHarness();

		h.source.emit('subagent.started', { agentId: 'agent-1', data: { toolCallId: 'tool-1' } });
		// The outer agent has already started its message before spawning the
		// sub-agent (as it always has in practice).
		h.source.emit('assistant.message_delta', { data: { deltaContent: 'outer text' } });
		// Sub-agent thinks, then speaks: the spoken content must thread under the
		// parent tool call (not the outer body) and close the open reasoning.
		h.source.emit('assistant.reasoning_delta', {
			agentId: 'agent-1',
			data: { deltaContent: 'planning the work' }
		});
		h.source.emit('assistant.message_delta', {
			agentId: 'agent-1',
			data: { deltaContent: 'here is my answer' }
		});
		h.source.emit('subagent.completed', { agentId: 'agent-1' });

		const childReasoning = h.events.find(
			(e) => e.type === 'message.reasoning' && e.parentToolCallId === 'tool-1'
		);
		expect(childReasoning).toBeTruthy();

		const childContent = h.events.find(
			(e) => e.type === 'message.delta' && e.parentToolCallId === 'tool-1'
		);
		expect(childContent).toMatchObject({
			type: 'message.delta',
			parentToolCallId: 'tool-1',
			text: 'here is my answer'
		});
		expect(childContent && 'segmentId' in childContent && childContent.segmentId).toBeTruthy();

		// Opening content closed the child reasoning segment first (so they
		// interleave), evidenced by a reasoning.end for the same parent emitted
		// before the content delta.
		const idxReasoningEnd = h.events.findIndex(
			(e) => e.type === 'message.reasoning.end' && e.parentToolCallId === 'tool-1'
		);
		const idxContent = h.events.findIndex(
			(e) => e.type === 'message.delta' && e.parentToolCallId === 'tool-1'
		);
		expect(idxReasoningEnd).toBeGreaterThanOrEqual(0);
		expect(idxReasoningEnd).toBeLessThan(idxContent);

		// The top-level delta is unthreaded (renders in the outer message body).
		const outer = h.events.find((e) => e.type === 'message.delta' && e.text === 'outer text');
		expect(
			outer && 'parentToolCallId' in outer ? outer.parentToolCallId : undefined
		).toBeUndefined();
	});
});

describe('SdkEventAdapter zod event boundary', () => {
	it('translates valid SDK payloads into portal events', () => {
		const h = makeHarness();

		h.source.emit('assistant.reasoning_delta', { data: { deltaContent: 'thinking' } });
		h.source.emit('tool.execution_start', {
			data: { toolCallId: 'tool-1', toolName: 'bash', arguments: { command: 'echo hi' } }
		});
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: 'ok' }
		});
		h.source.emit('session.usage_info', {
			data: {
				currentTokens: 10,
				tokenLimit: 100,
				messagesLength: 2,
				isInitial: true
			}
		});
		h.source.emit('assistant.message_delta', { data: { deltaContent: 'hello' } });
		h.source.emit('session.idle', {});

		expect(h.events.map((e) => e.type)).toEqual([
			'message.start',
			'message.reasoning',
			'message.reasoning.end',
			'tool.call',
			'tool.result',
			'context.usage',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(h.events.find((e) => e.type === 'tool.call')).toMatchObject({
			toolCallId: 'tool-1',
			tool: 'bash',
			args: { command: 'echo hi' }
		});
		expect(h.events.find((e) => e.type === 'context.usage')).toMatchObject({
			currentTokens: 10,
			tokenLimit: 100,
			messagesLength: 2,
			isInitial: true
		});
		expect(h.ended).toBe(true);
		expect(h.queue).toBeNull();
	});

	it('drops malformed SDK payloads instead of translating wrong shapes', () => {
		const h = makeHarness();

		h.source.emit('assistant.message_delta', { data: { deltaContent: 123 } });
		h.source.emit('tool.execution_progress', {
			data: { toolCallId: 'tool-1', progressMessage: { text: 'not a string' } }
		});
		h.source.emit('session.usage_info', {
			data: { currentTokens: '10', tokenLimit: 100, messagesLength: 2 }
		});
		h.source.emit('session.mode_changed', { data: { newMode: 123 } });

		expect(h.events).toEqual([]);
		expect(h.mode).toBe('interactive');
	});

	it('accepts mode changes only after payload validation and known mode filtering', () => {
		const h = makeHarness();

		h.source.emit('session.mode_changed', { data: { newMode: 'plan' } });
		h.source.emit('session.mode_changed', { data: { newMode: 'unsupported' } });

		expect(h.mode).toBe('plan');
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'session.settings',
			conversationId: 'conv-1',
			mode: 'plan',
			source: 'agent'
		});
	});
});

describe('SdkEventAdapter portal tool-result carriers', () => {
	const envelope = JSON.stringify({ ok: true, result: { files: ['a.txt'] } }, null, 2);

	function toolResult(h: ReturnType<typeof makeHarness>) {
		const ev = h.events.find((e) => e.type === 'tool.result');
		return ev && ev.type === 'tool.result' ? ev : null;
	}

	it('recovers the envelope from a structured detailedContent carrier', () => {
		const h = makeHarness();
		h.source.emit('tool.execution_complete', {
			data: {
				toolCallId: 'tool-1',
				success: true,
				result: { content: '1 file(s) changed.', detailedContent: envelope }
			}
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(true);
		// UI output is the full envelope JSON so structured cards can render.
		expect(r?.output).toBe(envelope);
	});

	it('recovers the envelope from a sessionLog carrier', () => {
		// `sessionLog` is the field the handler-side ToolResultObject carries the
		// full envelope on; a runtime that surfaces it (rather than mapping it to
		// `detailedContent`) must still drive structured UI rendering.
		const h = makeHarness();
		h.source.emit('tool.execution_complete', {
			data: {
				toolCallId: 'tool-1',
				success: true,
				result: { content: '1 file(s) changed.', sessionLog: envelope }
			}
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(true);
		expect(r?.output).toBe(envelope);
	});

	it('recovers the envelope from a legacy bare string carrier', () => {
		const h = makeHarness();
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: envelope }
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(true);
		expect(r?.output).toBe(envelope);
	});

	it('derives ok=false and the error summary from an error envelope', () => {
		const h = makeHarness();
		const errEnvelope = JSON.stringify(
			{ ok: false, error: { message: 'nothing to commit' } },
			null,
			2
		);
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: { detailedContent: errEnvelope } }
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(false);
		expect(r?.summary).toBe('nothing to commit');
		expect(r?.output).toBe(errEnvelope);
	});

	it('leaves native SDK tool results (non-envelope) untouched', () => {
		const h = makeHarness();
		const native = { content: 'short', detailedContent: 'full terminal output', contents: [] };
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: native }
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(true);
		// Native shape preserved verbatim so the client can render contents blocks.
		expect(r?.output).toEqual(native);
	});

	it('does not misread a native result with structured blocks as a portal envelope', () => {
		const h = makeHarness();
		// A native tool whose detailedContent happens to be envelope-shaped JSON
		// must NOT be unwrapped — its `contents` blocks mark it as native.
		const native = {
			content: 'ok',
			detailedContent: JSON.stringify({ ok: true, result: { spoofed: true } }),
			contents: [{ type: 'text', text: 'block' }]
		};
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: native }
		});
		const r = toolResult(h);
		expect(r?.ok).toBe(true);
		expect(r?.output).toEqual(native);
	});
});
