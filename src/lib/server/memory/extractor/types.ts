import type { MemoryExtractorBackend, MemoryMode, Message, ToolCallRecord } from '$lib/types';
import type { MemoryToolCall } from '$lib/server/db/repos/memory';
import type { MemoryPatchProposal, TurnMemoryPacket } from '../engine';

/**
 * Activity surfaced by a tool-calling extractor so callers (the turn runner)
 * can render the background agent's work like a normal subagent — a parent
 * card with each retrieval/staging call threaded underneath. Mirrors the
 * portal `tool.call` / `tool.result` event shapes so the runner can forward
 * them straight through its persistence path. The leading `input` event
 * carries the context handed to the extractor so the card can show its prompt.
 */
export type ExtractorActivity =
	| { type: 'input'; text: string }
	| { type: 'tool.call'; toolCallId: string; tool: string; args: unknown }
	| { type: 'tool.result'; toolCallId: string; ok: boolean; summary: string; output: string }
	| { type: 'reasoning'; segmentId: string; text: string }
	| { type: 'reasoning.end'; segmentId: string; durationMs: number }
	| { type: 'content'; segmentId: string; text: string };

export type ExtractorActivityEmitter = (activity: ExtractorActivity) => void;

export interface ExtractPatchInput {
	conversationId: string;
	userId: string;
	mode: MemoryMode;
	turnId: string;
	userMessage: Message;
	assistantMessage: Message;
	initialPacket?: TurnMemoryPacket;
	memoryToolCalls?: MemoryToolCall[];
	regularToolCalls?: ToolCallRecord[];
	recentTranscript?: Message[];
	extractorModel?: string | null;
	/**
	 * Optional per-conversation override for the extractor backend. When unset
	 * (NULL/undefined) the server default (`MEMORY_EXTRACTOR_BACKEND`) is used.
	 */
	extractorBackend?: MemoryExtractorBackend | null;
	/**
	 * Optional sink for live tool-calling extractor activity, so a caller can
	 * render the background agent running. Only the tool-calling extractor
	 * emits; other extractors ignore it.
	 */
	onActivity?: ExtractorActivityEmitter;
	/**
	 * Aborts the extraction. Wired to the owning turn's abort controller so a
	 * user "stop" issued while the background extractor is still running tears
	 * down its in-flight HTTP request(s) immediately instead of letting the
	 * subagent run to completion. The tool-calling extractor also checks it
	 * between iterations and tool calls.
	 */
	signal?: AbortSignal;
	/**
	 * Optional hook forwarded to `commitPatch` and invoked exactly once — only
	 * when the freshly extracted patch validates and is about to be applied
	 * (i.e. a committing patch), immediately before its items are written. The
	 * retry path uses it to undo the prior turn's patch only once a replacement
	 * is guaranteed to land, so a failed, timed-out, aborted, or `needs_review`
	 * retry never destroys the existing committed memory.
	 */
	beforeCommit?: () => void;
	/**
	 * Retry path only: the prior committed patch from THIS turn (its durable undo
	 * is deferred to commit time via `beforeCommit`). When set, the initial packet
	 * is built against the projection as of the START of this turn rather than the
	 * live state — see `readMemoryAtTurnStart` for the why and how. Ignored when
	 * the caller supplies its own `initialPacket`.
	 */
	priorPatchId?: string | null;
}

export interface ExtractPatchResult {
	patch: MemoryPatchProposal;
	confidence: number;
	summary: string;
	diagnostics: Array<{
		severity: 'info' | 'warning' | 'error';
		code: string;
		message: string;
	}>;
	rawModelOutput?: unknown;
	/**
	 * The model's final spoken text for the turn (the closing summary it writes
	 * after it stops calling tools). Surfaced as the extraction subagent card's
	 * "Response" so the background session reads like any other sub-session.
	 */
	response?: string;
}

export type Diagnostic = ExtractPatchResult['diagnostics'][number];

export interface MemoryExtractor {
	kind: string;
	model?: string;
	extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult>;
}

export interface ExtractorChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

export interface ExtractorToolSpec {
	type: 'function';
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ExtractorAssistantTurn {
	content: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	/** Provider-reported reasoning/thinking for this step, when available. */
	reasoning?: string;
}

/** Incremental tokens streamed from the model during a single chat step. */
export interface ExtractorStreamDelta {
	/** Provider reasoning/thinking tokens (`reasoning` / `reasoning_content`). */
	reasoning?: string;
	/** Spoken-content tokens (may include inline <think> tags). */
	content?: string;
}

export type ExtractorChatComplete = (
	messages: ExtractorChatMessage[],
	tools: ExtractorToolSpec[],
	onDelta?: (delta: ExtractorStreamDelta) => void,
	signal?: AbortSignal,
	toolChoice?: 'auto' | 'required'
) => Promise<ExtractorAssistantTurn>;
