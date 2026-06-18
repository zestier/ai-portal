import { describe, it, expect } from 'vitest';
import type { ToolInvocation } from '@github/copilot-sdk';
import { wrapToolsForStreaming } from '../src/lib/server/copilot/tool-streaming';
import type { PortalTool, ToolStreamContext } from '../src/lib/server/tools/git';
import { ok } from '../src/lib/server/tools/types';
import type { PortalEvent } from '../src/lib/types';

function fakeInvocation(toolCallId: string | undefined): ToolInvocation {
	return {
		sessionId: 'sess-1',
		toolCallId: toolCallId as string,
		toolName: 'demo',
		arguments: {}
	};
}

function demoTool(run: (args: unknown, ctx: ToolStreamContext) => Promise<string>): PortalTool {
	return {
		name: 'demo',
		description: 'demo tool',
		parameters: { type: 'object' },
		handler: async (args, ctx) => ok(await run(args, ctx as ToolStreamContext))
	};
}

describe('wrapToolsForStreaming', () => {
	it('forwards ctx.progress/ctx.partial as portal events bound to the runtime toolCallId', async () => {
		const events: PortalEvent[] = [];
		const tool = demoTool(async (_args, ctx) => {
			ctx.progress('working…');
			ctx.partial('chunk-1');
			ctx.partial('chunk-1chunk-2');
			return 'final';
		});
		const [wrapped] = wrapToolsForStreaming(
			[tool],
			(e) => events.push(e),
			() => null
		);

		const result = await wrapped.handler!({}, fakeInvocation('call-abc'));

		// The SDK adapter now returns a structured ToolResultObject: concise raw
		// model text on `textResultForLlm`; the full envelope rides on both
		// `sessionLog` (the field ToolResultObject carries it on) and
		// `detailedContent` (the runtime's output field) so it survives whichever
		// the deployment forwards.
		const fullEnvelope = JSON.stringify({ ok: true, result: 'final' }, null, 2);
		expect(result).toEqual({
			textResultForLlm: 'final',
			resultType: 'success',
			sessionLog: fullEnvelope,
			detailedContent: fullEnvelope
		});
		expect(events).toEqual([
			{ type: 'tool.progress', toolCallId: 'call-abc', message: 'working…' },
			{ type: 'tool.partial_output', toolCallId: 'call-abc', output: 'chunk-1' },
			{ type: 'tool.partial_output', toolCallId: 'call-abc', output: 'chunk-1chunk-2' }
		]);
	});

	it('gates emission when the current turn signal is aborted', async () => {
		const events: PortalEvent[] = [];
		const ac = new AbortController();
		ac.abort();
		const tool = demoTool(async (_args, ctx) => {
			ctx.progress('should be dropped');
			ctx.partial('should be dropped');
			return 'ok';
		});
		const [wrapped] = wrapToolsForStreaming(
			[tool],
			(e) => events.push(e),
			() => ac.signal
		);

		await wrapped.handler!({}, fakeInvocation('call-xyz'));

		expect(events).toEqual([]);
	});

	it('passes the live turn signal through to the handler ctx', async () => {
		const ac = new AbortController();
		let seen: AbortSignal | null = null;
		const tool = demoTool(async (_args, ctx) => {
			seen = ctx.signal;
			return 'ok';
		});
		const [wrapped] = wrapToolsForStreaming(
			[tool],
			() => {},
			() => ac.signal
		);

		await wrapped.handler!({}, fakeInvocation('call-1'));

		expect(seen).toBe(ac.signal);
	});

	it('does not emit when the runtime omits a toolCallId', async () => {
		const events: PortalEvent[] = [];
		const tool = demoTool(async (_args, ctx) => {
			ctx.progress('no id');
			ctx.partial('no id');
			return 'ok';
		});
		const [wrapped] = wrapToolsForStreaming(
			[tool],
			(e) => events.push(e),
			() => null
		);

		await wrapped.handler!({}, fakeInvocation(undefined));

		expect(events).toEqual([]);
	});

	it('preserves tool metadata (name, description, parameters)', () => {
		const tool = demoTool(async () => 'ok');
		const [wrapped] = wrapToolsForStreaming(
			[tool],
			() => {},
			() => null
		);
		expect(wrapped.name).toBe('demo');
		expect(wrapped.description).toBe('demo tool');
		expect(wrapped.parameters).toEqual({ type: 'object' });
	});
});
