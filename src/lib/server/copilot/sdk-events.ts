import { ulid } from 'ulid';
import { z } from 'zod';
import type { AsyncQueue } from '../runtime/async-queue';
import type {
	InteractiveRequestView,
	InteractiveRequestViewBody,
	PortalEvent,
	SessionMode
} from '$lib/types';
import { log } from '../log';
import { deriveEnvelopeSummary, parseEnvelopeJson } from '../tools/types';
import {
	cancel as cancelInteractive,
	newRequestId,
	register as registerInteractive
} from '../runtime/interactive-requests';
export type RuntimeSessionMode = 'interactive' | 'plan' | 'autopilot';

export interface SdkEventSource {
	on(event: string, listener: (e: unknown) => void): void;
	off?(event: string, listener: (e: unknown) => void): void;
}

interface EventAdapterContext {
	conversationId: string;
	getQueue(): AsyncQueue<PortalEvent> | null;
	setQueue(q: AsyncQueue<PortalEvent> | null): void;
	getMode(): SessionMode;
	setMode(mode: SessionMode): void;
	onSubagentLifecycle?(ev: {
		toolCallId: string;
		agentId: string;
		status: 'running' | 'completed' | 'failed';
	}): void;
}

interface ChildReasoningState {
	segmentId: string | null;
	startedAt: number;
}

const AssistantDeltaEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				deltaContent: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const AssistantMessageEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				content: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ToolStartEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				toolCallId: z.string().optional(),
				toolName: z.string().optional(),
				arguments: z.unknown().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ToolCompleteEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				toolCallId: z.string().optional(),
				success: z.boolean().optional(),
				result: z.unknown().optional(),
				error: z.unknown().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ToolPartialEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				toolCallId: z.string().optional(),
				partialOutput: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ToolProgressEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				toolCallId: z.string().optional(),
				progressMessage: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const SubagentStartedEvent = z
	.object({
		agentId: z.string().optional(),
		data: z
			.object({
				toolCallId: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const AgentEvent = z.object({ agentId: z.string().optional() }).passthrough();

const UsageInfoEvent = z
	.object({
		data: z
			.object({
				currentTokens: z.number().optional(),
				tokenLimit: z.number().optional(),
				messagesLength: z.number().optional(),
				systemTokens: z.number().optional(),
				conversationTokens: z.number().optional(),
				toolDefinitionsTokens: z.number().optional(),
				isInitial: z.boolean().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const CompactionCompleteEvent = z
	.object({
		data: z
			.object({
				tokensRemoved: z.number().optional(),
				messagesRemoved: z.number().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const SamplingRequestedEvent = z
	.object({
		data: z
			.object({
				requestId: z.string().optional(),
				serverName: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const McpOauthRequiredEvent = z
	.object({
		data: z
			.object({
				requestId: z.string().optional(),
				serverName: z.string().optional(),
				serverUrl: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ExternalToolRequestedEvent = z
	.object({
		data: z
			.object({
				requestId: z.string().optional(),
				toolName: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const RequestCompletedEvent = z
	.object({
		data: z
			.object({
				requestId: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

const ModeChangedEvent = z
	.object({
		data: z
			.object({
				newMode: z.string().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();

export class SdkEventAdapter {
	private currentMessageId: string | null = null;
	private currentReasoningSegmentId: string | null = null;
	private currentReasoningStartedAt = 0;
	private readonly subagentParentByAgentId = new Map<string, string>();
	private readonly childReasoning = new Map<string, ChildReasoningState>();
	private readonly childContent = new Map<string, string>();
	private readonly trackedInfoIds = new Map<string, string>();

	private attachedSession: SdkEventSource | null = null;
	private readonly registrations: Array<{
		event: string;
		handler: (e: unknown) => void;
	}> = [];

	constructor(private readonly ctx: EventAdapterContext) {}

	attach(sdkSession: SdkEventSource) {
		this.registrations.length = 0;
		const register = (event: string, handler: (e: unknown) => void) => {
			sdkSession.on(event, handler);
			this.registrations.push({ event, handler });
		};
		register('assistant.message_delta', this.onDelta);
		register('assistant.reasoning_delta', this.onReasoningDelta);
		register('assistant.message', this.onAssistantMessage);
		register('tool.execution_start', this.onToolStart);
		register('tool.execution_complete', this.onToolComplete);
		register('tool.execution_partial_result', this.onToolPartialResult);
		register('tool.execution_progress', this.onToolProgress);
		register('subagent.started', this.onSubagentStarted);
		register('subagent.completed', this.onSubagentCompleted);
		register('subagent.failed', this.onSubagentFailed);
		register('session.idle', this.onSessionIdle);
		register('session.usage_info', this.onUsageInfo);
		register('session.compaction_start', this.onCompactionStart);
		register('session.compaction_complete', this.onCompactionComplete);
		register('sampling.requested', this.onSamplingRequested);
		register('sampling.completed', this.onSamplingCompleted);
		register('mcp.oauth_required', this.onMcpOauthRequired);
		register('mcp.oauth_completed', this.onMcpOauthCompleted);
		register('external_tool.requested', this.onExternalToolRequested);
		register('external_tool.completed', this.onExternalToolCompleted);
		register('mode.changed', this.onModeChanged);
		this.attachedSession = sdkSession;
	}

	detach() {
		const session = this.attachedSession;
		if (session) {
			for (const { event, handler } of this.registrations) {
				session.off?.(event, handler);
			}
		}
		this.registrations.length = 0;
		this.attachedSession = null;
	}

	resetTurn() {
		this.currentMessageId = null;
		this.currentReasoningSegmentId = null;
		this.currentReasoningStartedAt = 0;
		this.subagentParentByAgentId.clear();
		this.childReasoning.clear();
		this.childContent.clear();
		this.trackedInfoIds.clear();
	}

	private get activeQueue(): AsyncQueue<PortalEvent> | null {
		return this.ctx.getQueue();
	}

	private emit(ev: PortalEvent) {
		this.activeQueue?.push(ev);
	}

	private parentToolCallId(ev: { agentId?: string }): string | undefined {
		const agentId = ev.agentId;
		if (!agentId) return undefined;
		return this.subagentParentByAgentId.get(agentId);
	}

	private closeReasoning() {
		if (!this.activeQueue || !this.currentReasoningSegmentId || !this.currentMessageId) return;
		this.emit({
			type: 'message.reasoning.end',
			messageId: this.currentMessageId,
			segmentId: this.currentReasoningSegmentId,
			durationMs: Date.now() - this.currentReasoningStartedAt
		});
		this.currentReasoningSegmentId = null;
		this.currentReasoningStartedAt = 0;
	}

	private ensureMessageStarted(): string {
		if (!this.currentMessageId) {
			this.currentMessageId = ulid();
			this.emit({
				type: 'message.start',
				messageId: this.currentMessageId,
				role: 'assistant'
			});
		}
		return this.currentMessageId;
	}

	private readonly onDelta = (e: unknown) => {
		const ev = parseSdkEvent('assistant.message_delta', AssistantDeltaEvent, e);
		if (!ev) return;
		const text = ev?.data?.deltaContent ?? '';
		if (!text || !this.activeQueue) return;
		if (ev.agentId) {
			// Sub-agent spoken content: thread it into the spawning card as a
			// content block (interleaved with the agent's reasoning/tools), so a
			// nested agent renders its response like a top-level agent instead of
			// only surfacing it as the final tool result.
			const parent = this.parentToolCallId(ev);
			const messageId = this.ensureMessageStarted();
			if (!parent) return;
			// Opening content closes any in-flight child reasoning so the two
			// interleave in timestamp order.
			this.closeChildReasoning(ev.agentId);
			let segmentId = this.childContent.get(ev.agentId);
			if (!segmentId) {
				segmentId = ulid();
				this.childContent.set(ev.agentId, segmentId);
			}
			this.emit({
				type: 'message.delta',
				messageId,
				text,
				parentToolCallId: parent,
				segmentId
			});
			return;
		}
		const messageId = this.ensureMessageStarted();
		this.closeReasoning();
		this.emit({ type: 'message.delta', messageId, text });
	};

	private readonly onReasoningDelta = (e: unknown) => {
		const ev = parseSdkEvent('assistant.reasoning_delta', AssistantDeltaEvent, e);
		if (!ev) return;
		let text = ev?.data?.deltaContent ?? '';
		if (!text || !this.activeQueue) return;
		const parent = this.parentToolCallId(ev);
		if (parent) {
			if (!this.currentMessageId || !ev.agentId) return;
			// Opening reasoning closes any in-flight child content block so the
			// two interleave in order.
			this.closeChildContent(ev.agentId);
			let state = this.childReasoning.get(ev.agentId);
			if (!state || !state.segmentId) {
				state = { segmentId: ulid(), startedAt: Date.now() };
				this.childReasoning.set(ev.agentId, state);
				text = text.replace(/^\s+/, '');
				if (!text) return;
			}
			const segmentId = state.segmentId;
			if (!segmentId) return;
			this.emit({
				type: 'message.reasoning',
				messageId: this.currentMessageId,
				segmentId,
				text,
				parentToolCallId: parent
			});
			return;
		}
		const messageId = this.ensureMessageStarted();
		if (!this.currentReasoningSegmentId) {
			this.currentReasoningSegmentId = ulid();
			this.currentReasoningStartedAt = Date.now();
			text = text.replace(/^\s+/, '');
			if (!text) return;
		}
		this.emit({
			type: 'message.reasoning',
			messageId,
			segmentId: this.currentReasoningSegmentId,
			text
		});
	};

	private readonly onAssistantMessage = (e: unknown) => {
		const ev = parseSdkEvent('assistant.message', AssistantMessageEvent, e);
		if (!ev) return;
		if (ev.agentId) {
			this.closeChildReasoning(ev.agentId);
			return;
		}
		if (!this.activeQueue) return;
		if (!this.currentMessageId) {
			const messageId = this.ensureMessageStarted();
			const text = ev?.data?.content ?? '';
			if (text) {
				this.closeReasoning();
				this.emit({ type: 'message.delta', messageId, text });
			}
		}
	};

	private readonly onToolStart = (e: unknown) => {
		const ev = parseSdkEvent('tool.execution_start', ToolStartEvent, e);
		if (!ev) return;
		if (!this.activeQueue) return;
		const parent = this.parentToolCallId(ev);
		if (parent && ev.agentId) {
			this.closeChildReasoning(ev.agentId);
			this.closeChildContent(ev.agentId);
		} else this.closeReasoning();
		this.emit({
			type: 'tool.call',
			toolCallId: ev?.data?.toolCallId ?? ulid(),
			tool: ev?.data?.toolName ?? 'unknown',
			args: ev?.data?.arguments ?? null,
			parentToolCallId: parent
		});
	};

	private readonly onToolComplete = (e: unknown) => {
		const ev = parseSdkEvent('tool.execution_complete', ToolCompleteEvent, e);
		if (!ev) return;
		if (!this.activeQueue) return;
		// Portal tools hand back a structured result whose full serialized envelope
		// rides on the detail channel. Recover it from whichever carrier the
		// runtime relayed (object `detailedContent`/`sessionLog`/`content`, or a
		// legacy bare string) and derive ok/summary plus the UI `output` from that
		// one envelope. Native SDK tools (non-envelope results) keep their existing
		// `{ content, detailedContent, contents }` handling untouched.
		const raw = ev?.data?.result;
		const envelopeJson = portalEnvelopeCarrier(raw);
		const envelope = envelopeJson === null ? null : parseEnvelopeJson(envelopeJson);
		if (envelope) {
			this.emit({
				type: 'tool.result',
				toolCallId: ev?.data?.toolCallId ?? ulid(),
				ok: envelope.ok,
				summary: deriveEnvelopeSummary(envelope),
				output: envelopeJson,
				parentToolCallId: this.parentToolCallId(ev)
			});
			return;
		}
		const ok = ev?.data?.success !== false && !ev?.data?.error;
		const summary = summarizeResult(raw, ev?.data?.error);
		this.emit({
			type: 'tool.result',
			toolCallId: ev?.data?.toolCallId ?? ulid(),
			ok,
			summary,
			output: raw ?? ev?.data?.error ?? null,
			parentToolCallId: this.parentToolCallId(ev)
		});
	};

	private readonly onToolPartialResult = (e: unknown) => {
		const ev = parseSdkEvent('tool.execution_partial_result', ToolPartialEvent, e);
		if (!ev) return;
		if (!this.activeQueue) return;
		const id = ev?.data?.toolCallId;
		const out = ev?.data?.partialOutput;
		if (!id || typeof out !== 'string' || out.length === 0) return;
		this.emit({
			type: 'tool.partial_output',
			toolCallId: id,
			output: out,
			parentToolCallId: this.parentToolCallId(ev)
		});
	};

	private readonly onToolProgress = (e: unknown) => {
		const ev = parseSdkEvent('tool.execution_progress', ToolProgressEvent, e);
		if (!ev) return;
		if (!this.activeQueue) return;
		const id = ev?.data?.toolCallId;
		const msg = ev?.data?.progressMessage;
		if (!id || typeof msg !== 'string' || msg.length === 0) return;
		this.emit({
			type: 'tool.progress',
			toolCallId: id,
			message: msg,
			parentToolCallId: this.parentToolCallId(ev)
		});
	};

	private readonly onSubagentStarted = (e: unknown) => {
		const ev = parseSdkEvent('subagent.started', SubagentStartedEvent, e);
		if (!ev) return;
		if (ev.agentId && ev.data?.toolCallId) {
			this.subagentParentByAgentId.set(ev.agentId, ev.data.toolCallId);
			this.emitSubagentLifecycle(ev.data.toolCallId, ev.agentId, 'running');
		}
	};

	private readonly onSubagentCompleted = (e: unknown) => {
		this.onSubagentEnded(e, 'completed');
	};

	private readonly onSubagentFailed = (e: unknown) => {
		this.onSubagentEnded(e, 'failed');
	};

	private onSubagentEnded(e: unknown, status: 'completed' | 'failed') {
		const ev = parseSdkEvent('subagent.ended', AgentEvent, e);
		if (!ev) return;
		if (!ev.agentId) return;
		const toolCallId = this.subagentParentByAgentId.get(ev.agentId);
		this.closeChildReasoning(ev.agentId);
		this.childReasoning.delete(ev.agentId);
		this.closeChildContent(ev.agentId);
		if (toolCallId) this.emitSubagentLifecycle(toolCallId, ev.agentId, status);
		this.subagentParentByAgentId.delete(ev.agentId);
	}

	private emitSubagentLifecycle(
		toolCallId: string,
		agentId: string,
		status: 'running' | 'completed' | 'failed'
	) {
		this.ctx.onSubagentLifecycle?.({ toolCallId, agentId, status });
		this.emit({
			type: 'subagent.lifecycle',
			toolCallId,
			agentId,
			status
		});
	}

	private closeChildReasoning(agentId: string) {
		const state = this.childReasoning.get(agentId);
		if (state?.segmentId && this.currentMessageId && this.activeQueue) {
			this.emit({
				type: 'message.reasoning.end',
				messageId: this.currentMessageId,
				segmentId: state.segmentId,
				durationMs: Date.now() - state.startedAt,
				parentToolCallId: this.subagentParentByAgentId.get(agentId)
			});
			state.segmentId = null;
		}
	}

	// Content blocks accumulate by segmentId and need no explicit end event;
	// "closing" simply drops the active segment so the next content delta opens
	// a fresh block, letting content interleave with reasoning/tools in order.
	private closeChildContent(agentId: string) {
		this.childContent.delete(agentId);
	}

	private readonly onSessionIdle = () => {
		const q = this.activeQueue;
		if (!q) return;
		this.closeReasoning();
		if (this.currentMessageId) {
			this.emit({ type: 'message.end', messageId: this.currentMessageId });
			this.currentMessageId = null;
		}
		this.emit({ type: 'done' });
		q.end();
		this.ctx.setQueue(null);
	};

	private readonly onUsageInfo = (e: unknown) => {
		const ev = parseSdkEvent('session.usage_info', UsageInfoEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (!this.activeQueue || !d) return;
		if (typeof d.currentTokens !== 'number' || typeof d.tokenLimit !== 'number') return;
		this.emit({
			type: 'context.usage',
			currentTokens: d.currentTokens,
			tokenLimit: d.tokenLimit,
			messagesLength: d.messagesLength ?? 0,
			systemTokens: d.systemTokens,
			conversationTokens: d.conversationTokens,
			toolDefinitionsTokens: d.toolDefinitionsTokens,
			isInitial: d.isInitial
		});
	};

	private readonly onCompactionStart = () => {
		if (this.activeQueue) this.emit({ type: 'context.compaction', phase: 'start' });
	};

	private readonly onCompactionComplete = (e: unknown) => {
		const ev = parseSdkEvent('session.compaction_complete', CompactionCompleteEvent, e);
		if (!ev) return;
		if (!this.activeQueue) return;
		this.emit({
			type: 'context.compaction',
			phase: 'complete',
			tokensRemoved: ev?.data?.tokensRemoved,
			messagesRemoved: ev?.data?.messagesRemoved
		});
	};

	private emitInfoRequest(
		kind: 'sampling' | 'mcp_oauth' | 'external_tool',
		sdkRequestId: string,
		view: InteractiveRequestViewBody
	) {
		if (!this.activeQueue || !sdkRequestId) return;
		const requestId = newRequestId();
		const full = { requestId, ...view } as InteractiveRequestView;
		this.trackedInfoIds.set(sdkRequestId, requestId);
		registerInteractive({
			requestId,
			conversationId: this.ctx.conversationId,
			kind,
			view: full,
			resolve: () => undefined,
			reject: () => undefined,
			emit: (ev) => this.emit(ev)
		});
		this.emit({ type: 'interactive.request', request: full });
	}

	private dismissInfoRequest(sdkRequestId: string) {
		const requestId = this.trackedInfoIds.get(sdkRequestId);
		if (!requestId) return;
		this.trackedInfoIds.delete(sdkRequestId);
		cancelInteractive(requestId, 'sdk_resolved');
	}

	private readonly onSamplingRequested = (e: unknown) => {
		const ev = parseSdkEvent('sampling.requested', SamplingRequestedEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (!d?.requestId) return;
		this.emitInfoRequest('sampling', d.requestId, {
			kind: 'sampling',
			mcpServerName: d.serverName,
			summary: `MCP server "${d.serverName ?? 'unknown'}" is requesting an LLM sampling call.`
		});
	};

	private readonly onSamplingCompleted = (e: unknown) => {
		const ev = parseSdkEvent('sampling.completed', RequestCompletedEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (d?.requestId) this.dismissInfoRequest(d.requestId);
	};

	private readonly onMcpOauthRequired = (e: unknown) => {
		const ev = parseSdkEvent('mcp.oauth_required', McpOauthRequiredEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (!d?.requestId) return;
		this.emitInfoRequest('mcp_oauth', d.requestId, {
			kind: 'mcp_oauth',
			mcpServerName: d.serverName,
			authorizationUrl: d.serverUrl,
			summary: `MCP server "${d.serverName ?? 'unknown'}" requires OAuth authentication. Complete the flow in your browser to continue.`
		});
	};

	private readonly onMcpOauthCompleted = (e: unknown) => {
		const ev = parseSdkEvent('mcp.oauth_completed', RequestCompletedEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (d?.requestId) this.dismissInfoRequest(d.requestId);
	};

	private readonly onExternalToolRequested = (e: unknown) => {
		const ev = parseSdkEvent('external_tool.requested', ExternalToolRequestedEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (!d?.requestId) return;
		this.emitInfoRequest('external_tool', d.requestId, {
			kind: 'external_tool',
			toolName: d.toolName ?? 'unknown',
			summary: `Waiting for external tool "${d.toolName ?? 'unknown'}" to complete.`
		});
	};

	private readonly onExternalToolCompleted = (e: unknown) => {
		const ev = parseSdkEvent('external_tool.completed', RequestCompletedEvent, e);
		if (!ev) return;
		const d = ev.data;
		if (d?.requestId) this.dismissInfoRequest(d.requestId);
	};

	private readonly onModeChanged = (e: unknown) => {
		const ev = parseSdkEvent('mode.changed', ModeChangedEvent, e);
		if (!ev) return;
		const raw = ev.data?.newMode;
		const next = isRuntimeSessionMode(raw) ? raw : null;
		if (!next || next === toRuntimeMode(this.ctx.getMode())) return;
		this.ctx.setMode(next);
		this.emit({
			type: 'session.settings',
			conversationId: this.ctx.conversationId,
			mode: next,
			source: 'agent'
		});
	};
}

// Locate the portal envelope JSON within the SDK's `tool.execution_complete`
// result, regardless of how the runtime relayed our structured result:
//   - a bare string (legacy / runtimes that pass the handler return verbatim);
//   - an object exposing the full payload on `detailedContent` (the runtime's
//     `ToolExecutionCompleteResult` field) or `sessionLog` (the field the
//     handler-side `ToolResultObject` actually carries it on), falling back to
//     `content`.
// Returns null for native SDK tool shapes so their handling is preserved: a
// non-empty `contents` block array is the runtime's marker for a native tool
// returning structured content, so we never dig into such results for an
// envelope (which would otherwise risk a false positive if their text happened
// to be envelope-shaped JSON, dropping the `contents` blocks). The subsequent
// `parseEnvelopeJson` also rejects any non-envelope string we do surface (e.g. a
// native tool's plain `detailedContent`, or the concise model `content`).
function portalEnvelopeCarrier(result: unknown): string | null {
	if (typeof result === 'string') return result;
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		const rec = result as Record<string, unknown>;
		if (Array.isArray(rec.contents) && rec.contents.length > 0) return null;
		if (typeof rec.detailedContent === 'string') return rec.detailedContent;
		if (typeof rec.sessionLog === 'string') return rec.sessionLog;
		if (typeof rec.content === 'string') return rec.content;
	}
	return null;
}

function summarizeResult(result: unknown, error: unknown): string {
	if (error) return typeof error === 'string' ? error : 'error';
	if (typeof result === 'string') return result.slice(0, 200);
	if (result && typeof result === 'object') {
		try {
			return JSON.stringify(result).slice(0, 200);
		} catch {
			return 'object';
		}
	}
	return 'ok';
}

function parseSdkEvent<T extends z.ZodTypeAny>(
	event: string,
	schema: T,
	payload: unknown
): z.infer<T> | null {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	log.warn('copilot.sdk_event.invalid', {
		event,
		issues: parsed.error.issues.map((issue) => ({
			path: issue.path.join('.'),
			message: issue.message
		}))
	});
	return null;
}

export function toRuntimeMode(mode: SessionMode): RuntimeSessionMode {
	return mode === 'best-effort' ? 'autopilot' : mode;
}

function isRuntimeSessionMode(value: string | undefined): value is RuntimeSessionMode {
	return value === 'interactive' || value === 'plan' || value === 'autopilot';
}
