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

import type {
	Tool as SdkTool,
	ToolInvocation as SdkToolInvocation,
	ToolResultObject
} from '@github/copilot-sdk';
import type { PortalEvent } from '$lib/types';
import type { PortalTool, ToolStreamContext } from '../tools/git';
import { deriveToolResultViews, err, type ToolResult } from '../tools/types';

// SDK adapter: package a handler's envelope into the SDK's structured
// `ToolResultObject` so the two derived views travel on SEPARATE channels
// instead of being fused into one escaped JSON string:
//   - `textResultForLlm` ← concise, RAW model text (real newlines/tabs).
//   - full serialized envelope ← carried for the UI, which `sdk-events.ts`
//     recovers to drive structured UI rendering.
// `resultType` reflects ok/error (and `error` carries the message on failure).
// This mirrors the OpenAI-compatible edge, which performs the same split via
// `deriveToolResultViews`; both edges share that one derive step so the
// model/UI views cannot drift.
//
// Carrier note: the handler-return contract the SDK accepts is `ToolResultObject`
// (and the RPC `ExternalToolTextResultForLlm` it maps onto). Its documented field
// for "detailed content for timeline display" is `sessionLog`, so that is the
// primary carrier for the full payload. The runtime's *output* event
// (`ToolExecutionCompleteResult`) exposes the detail as `detailedContent`, so we
// also mirror the payload onto `detailedContent` (preserved by the input
// schema's open `[k: string]: unknown`) for runtimes that read it directly.
// `sdk-events.ts` recovers from whichever survives, and degrades to raw text if
// a deployment drops both.
type PortalSdkToolResult = ToolResultObject & { detailedContent?: string };

function toSdkResult(envelope: ToolResult): PortalSdkToolResult {
	const views = deriveToolResultViews(envelope);
	const result: PortalSdkToolResult = {
		textResultForLlm: views.modelText,
		resultType: views.ok ? 'success' : 'failure',
		sessionLog: views.fullContent,
		detailedContent: views.fullContent
	};
	if (!views.ok) result.error = views.summary;
	return result;
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
				return toSdkResult(await tool.handler(args, ctx));
			} catch (e) {
				// Central try/catch normalizes thrown exceptions into the same
				// `{ ok: false, error }` envelope handlers may return directly.
				return toSdkResult(err(e instanceof Error ? e.message : String(e)));
			}
		}
	}));
}
