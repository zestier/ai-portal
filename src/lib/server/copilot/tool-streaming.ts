// Bridges custom portal tools into the Copilot SDK's streaming model.
//
// The SDK invokes a custom tool's `handler(args, invocation)` with its own
// `ToolInvocation`, which carries no channel for the handler to report
// incremental output — those `tool.execution_partial_result` /
// `tool.execution_progress` events are emitted by the runtime only for its
// native tools. Portal tools run in *our* process, though, so we wrap each
// handler to synthesize a `ToolStreamContext` bound to the runtime's
// `toolCallId` and this provider's `emit`. Calling `ctx.partial` / `ctx.progress`
// then pushes the same ephemeral `tool.partial_output` / `tool.progress` portal
// events that `sdk-events.ts` emits for native tools, interleaved between the
// `tool.call` and `tool.result` for the same `toolCallId`.

import type { Tool as SdkTool, ToolInvocation as SdkToolInvocation } from '@github/copilot-sdk';
import type { PortalEvent } from '$lib/types';
import type { PortalTool, ToolStreamContext } from '../tools/git';
import { err, type ToolResult } from '../tools/types';

// Serialize a handler's envelope exactly once into the text the SDK runtime
// hands back to the model (and that `sdk-events.ts` re-surfaces to the UI as the
// `tool.result` output). Matches the OpenAI-compatible provider's boundary
// serialization so both paths share one wire shape.
function serializeToolResult(envelope: ToolResult): string {
	return JSON.stringify(envelope, null, 2);
}

export function wrapToolsForStreaming(
	tools: PortalTool[],
	emit: (ev: PortalEvent) => void,
	getSignal: () => AbortSignal | null
): SdkTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		handler: async (args: unknown, invocation: SdkToolInvocation) => {
			const toolCallId = invocation?.toolCallId;
			const ctx: ToolStreamContext = {
				partial(output) {
					if (toolCallId && !getSignal()?.aborted) {
						emit({ type: 'tool.partial_output', toolCallId, output });
					}
				},
				progress(message) {
					if (toolCallId && !getSignal()?.aborted) {
						emit({ type: 'tool.progress', toolCallId, message });
					}
				},
				signal: getSignal() ?? new AbortController().signal
			};
			try {
				return serializeToolResult(await tool.handler(args, ctx));
			} catch (e) {
				// Central try/catch normalizes thrown exceptions into the same
				// `{ ok: false, error }` envelope handlers may return directly.
				return serializeToolResult(err(e instanceof Error ? e.message : String(e)));
			}
		}
	}));
}
