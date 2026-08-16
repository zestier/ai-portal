import { ulid } from 'ulid';
import { log } from '../log';
import * as messages from '../db/repos/messages';
import { mintReasoningBlockId, mintToolCallId } from '../db/repos/messages';
import {
	conversationId as convCodec,
	messageId as msgCodec,
	toolCallId as toolCodec
} from '$lib/ids';
import { extractAndCommitMemory, type ExtractorActivity } from '../memory/extractor';
import { ModelCompletionError } from '../pi/complete';
import { loadConfig } from '../config';
import type { MemoryMode, PortalEvent } from '$lib/types';

export interface PendingTool {
	toolCallId: number;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
	parentToolCallId: number | null;
}

export interface PendingReasoning {
	id: number;
	segmentIndex: number;
	text: string;
	kind: 'reasoning' | 'content';
	textOffset: number | null;
	startedAt: number;
	durationMs: number | null;
	parentToolCallId: number | null;
}

// Nudge used by the memory-mode continuation guard. Some models treat a single
// memory recall call as the whole turn — they query memory, then end without
// ever answering the user. When a memory-mode turn produces no user-facing text
// and the model itself only fired recall tools, we re-send this once so the
// model uses what it retrieved and actually responds.
export const MEMORY_CONTINUATION_NUDGE =
	'You queried durable memory but have not yet answered me. A memory tool call is not a response, and I never see tool output directly. Using what you retrieved, respond to my message now. Do not end your turn without a substantive reply.';

// Read-only memory recall tools exposed to the model. Deliberately excludes
// write/mutation tools (memory_global_record, memory_merge_entities): a turn
// that *wrote* memory without answering is not the "recall then nothing"
// failure this guard targets, so it must not be nudged. Keep in sync with the
// recall tools advertised in memory/engine.ts.
export const MEMORY_RECALL_TOOLS = new Set([
	'memory_search',
	'memory_get_entity',
	'memory_get_open_loops',
	'memory_get_recent_events',
	'memory_get_transcript',
	'memory_query_timeline',
	'memory_query_clues',
	'memory_get_character_knowledge',
	'memory_check_claims',
	'memory_global_search'
]);

// True when the turn yielded no assistant text and every top-level tool call the
// model made was a memory recall — the "checked memory then ended the turn"
// failure mode. Sub-agent (child) tool calls are ignored: they belong to a
// non-memory parent tool, which represents real work, not the failure mode.
export function isMemoryOnlyEmptyTurn(
	assistantText: string,
	tools: Map<number, PendingTool>
): boolean {
	if (assistantText.trim().length > 0) return false;
	let sawTopLevelRecall = false;
	for (const t of tools.values()) {
		if (t.parentToolCallId !== null) continue;
		if (!MEMORY_RECALL_TOOLS.has(t.tool)) return false;
		sawTopLevelRecall = true;
	}
	return sawTopLevelRecall;
}

export function safeJson(v: unknown): string {
	try {
		return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

// Race a memory extraction against two deadlines so it can never wedge the
// turn in `running`: a short post-abort finalize deadline (the turn must free
// promptly after a user Stop) and an absolute ceiling on the whole extraction
// phase (so even an abort-ignoring provider is bounded). On either trip we
// abort the extractor's signal, mark the pass abandoned (so late callbacks
// no-op), and reject — letting the caller's catch finalize the turn. The
// timeout rejects with a plain (non-abort) Error and does NOT touch `turnAc`,
// so the caller distinguishes a timeout (`needs_review`) from a user Stop
// (`skipped`) via `turnAc.signal.aborted`.
function runExtractionWithWatchdog<T>(
	pending: Promise<T>,
	ctx: {
		turnAc: AbortController;
		extractionAc: AbortController;
		cfg: ReturnType<typeof loadConfig>;
		onAbandon?: () => void;
	}
): Promise<T> {
	const { turnAc, extractionAc, cfg, onAbandon } = ctx;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let deadlineArmed = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const track = (timer: ReturnType<typeof setTimeout>) => {
			(timer as { unref?: () => void }).unref?.();
			timers.push(timer);
		};
		const cleanup = () => {
			for (const timer of timers) clearTimeout(timer);
			turnAc.signal.removeEventListener('abort', armDeadline);
		};
		const trip = (reason: Error) => {
			if (settled) return;
			settled = true;
			onAbandon?.();
			extractionAc.abort();
			cleanup();
			reject(reason);
		};
		function armDeadline() {
			if (deadlineArmed) return;
			deadlineArmed = true;
			track(
				setTimeout(
					() => trip(new Error('Memory extraction was cancelled.')),
					cfg.TURN_ABORT_FINALIZE_DEADLINE_MS
				)
			);
		}
		track(
			setTimeout(
				() => trip(new Error('Memory extraction exceeded its time budget and was abandoned.')),
				cfg.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS + cfg.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS
			)
		);
		if (turnAc.signal.aborted) armDeadline();
		else turnAc.signal.addEventListener('abort', armDeadline, { once: true });
		pending.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(err) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			}
		);
	});
}

function memoryFailureMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

function memoryFailureSummary(err: unknown): string {
	const message = memoryFailureMessage(err);
	return message
		? `Memory extraction failed; response was preserved. ${message}`
		: 'Memory extraction failed; response was preserved.';
}

function memoryFailureLogFields(err: unknown): Record<string, unknown> {
	if (err instanceof ModelCompletionError) return { extractorModel: err.model };
	return {};
}

// A compact `dispatch` for the memory-extraction retry path. Unlike the full
// turn `dispatch`, it never appends a new assistant message: the retry re-runs
// extraction for an *existing* assistant message, so the extractor's subagent
// card (and its threaded reasoning/content/tool activity) is persisted onto
// that message id. It handles exactly the event subset the extractor emits and
// mirrors the persistence the full `dispatch` performs for those events so the
// retry card survives reloads and appears in history just like a post-turn one.
export function makeExtractorCardDispatch(
	emit: (ev: PortalEvent) => void,
	assistantMessageId: string
): (ev: PortalEvent) => void {
	const pendingReasoning = new Map<string, PendingReasoning>();
	let nextReasoningIndex = 0;
	return (ev: PortalEvent) => {
		if (ev.type === 'tool.call') {
			emit({ ...ev, messageId: assistantMessageId });
			messages.upsertToolCall(msgCodec.parse(assistantMessageId), {
				id: toolCodec.parse(ev.toolCallId),
				tool: ev.tool,
				argsJson: safeJson(ev.args),
				resultJson: null,
				status: 'pending',
				startedAt: Date.now(),
				endedAt: null,
				textOffset: null,
				parentToolCallId: ev.parentToolCallId ? toolCodec.parse(ev.parentToolCallId) : null
			});
		} else if (ev.type === 'tool.result') {
			emit(ev);
			messages.updateToolCall(toolCodec.parse(ev.toolCallId), {
				status: ev.ok ? 'ok' : 'error',
				resultJson: safeJson(ev.output ?? ev.summary),
				endedAt: Date.now()
			});
		} else if (ev.type === 'subagent.lifecycle') {
			emit(ev);
			messages.updateBackgroundAgentLifecycle(
				toolCodec.parse(ev.toolCallId),
				ev.agentId,
				ev.status
			);
		} else if (ev.type === 'message.reasoning') {
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				seg = {
					id: mintReasoningBlockId(),
					segmentIndex: nextReasoningIndex++,
					text: '',
					kind: 'reasoning',
					textOffset: null,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: ev.parentToolCallId ? toolCodec.parse(ev.parentToolCallId) : null
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(msgCodec.parse(assistantMessageId), seg);
			emit({ ...ev, messageId: assistantMessageId });
		} else if (ev.type === 'message.reasoning.end') {
			const seg = pendingReasoning.get(ev.segmentId);
			if (seg) {
				seg.durationMs = ev.durationMs;
				messages.upsertReasoningBlock(msgCodec.parse(assistantMessageId), seg);
			}
			emit({ ...ev, messageId: assistantMessageId });
		} else if (ev.type === 'message.delta' && ev.parentToolCallId && ev.segmentId) {
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				seg = {
					id: mintReasoningBlockId(),
					segmentIndex: nextReasoningIndex++,
					text: '',
					kind: 'content',
					textOffset: null,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: toolCodec.parse(ev.parentToolCallId)
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(msgCodec.parse(assistantMessageId), seg);
			emit({ ...ev, messageId: assistantMessageId });
		} else {
			emit(ev);
		}
	};
}

export interface MemoryExtractionCardOptions {
	emit: (ev: PortalEvent) => void;
	// Routes the extractor's parent card + threaded children through whichever
	// persistence path the caller owns: the full turn `dispatch` (post-turn) or
	// `makeExtractorCardDispatch` (retry, which writes onto an existing message).
	dispatch: (ev: PortalEvent) => void;
	// User-Stop signal for the owning turn. Linked to a dedicated extraction
	// signal that also fires on a watchdog trip.
	turnAc: AbortController;
	cfg: ReturnType<typeof loadConfig>;
	conversationId: number;
	userId: number;
	// The assistant message the extractor card is attached to; its content is the
	// turn's assistant response (reused verbatim — never regenerated here).
	assistantMessageId: string;
	assistantContent: string;
	userMessageId: string;
	userContent: string;
	mode: MemoryMode;
	extractorModel?: string | null | undefined;
	turnId: string;
	// Card label + "extracting" status copy — the only user-visible difference
	// between a normal post-turn extraction and an explicit retry.
	cardDescription: string;
	extractingSummary: string;
	// Log namespace ('turn.memory' | 'memory.retry') for the abort/fail records,
	// and the card body shown when a user Stop cancels the extraction.
	logPrefix: string;
	cancelOutput: string;
	// Retry path only: undo the prior committed patch. Forwarded to
	// `commitPatch`, which fires it once the replacement patch validates, so a
	// failed/aborted/needs_review retry leaves the existing memory intact.
	beforeCommit?: (() => void) | undefined;
	// Retry path only: the prior committed patch from this turn, forwarded to the
	// extractor so it builds its initial packet against the turn-start projection
	// rather than the live state. See `ExtractPatchInput.priorPatchId`.
	priorPatchId?: number | null | undefined;
}

/**
 * Run the memory-extraction step and surface it as a subagent-style card via
 * `dispatch`, emitting the `extracting -> validating -> committed/needs_review`
 * `memory.status` lifecycle through `emit`. Shared by the normal post-turn
 * extraction and the extraction-only retry: both create the lazy extractor
 * parent card, thread extractor activity through `dispatch`, run behind the
 * abort watchdog, and translate the outcome (or a user Stop / watchdog trip /
 * error) into the matching card result and status event.
 *
 * Never throws: memory faults are caught here and surfaced as `needs_review` (or
 * `skipped` on a user Stop), so a memory failure can never wedge or fail the
 * turn that owns it.
 */
export async function runMemoryExtractionCard(o: MemoryExtractionCardOptions): Promise<void> {
	// Created lazily on the first activity event so extractors that emit nothing
	// (heuristic / single-shot JSON) never spawn an empty card. Declared out here
	// so the catch below can close the card if extraction throws.
	let extractorParentId: number | null = null;
	let extractorAgentId: string | null = null;
	// `extractionAc` is the signal actually handed to the extractor: it fires on
	// a user Stop (linked from the turn signal) and on a watchdog trip, so both
	// the in-flight request and the pre-commit guard observe an abort — no
	// partial patch can land.
	const extractionAc = new AbortController();
	const linkExtractionAbort = () => extractionAc.abort(o.turnAc.signal.reason);
	if (o.turnAc.signal.aborted) linkExtractionAbort();
	else o.turnAc.signal.addEventListener('abort', linkExtractionAbort, { once: true });
	// Once the watchdog abandons a stuck extraction, every later extractor-sourced
	// callback must become a no-op: the turn is being finalized. Guarded at the
	// single `onActivity` entry point.
	let abandoned = false;
	const ensureExtractorParent = (prompt?: string): string => {
		if (extractorParentId) return toolCodec.encode(extractorParentId);
		extractorParentId = mintToolCallId();
		extractorAgentId = `mem_agent_${ulid()}`;
		// Emit the same event shape as a real subagent: a `task` tool call plus a
		// `subagent.lifecycle` start. The `agent_type` arg lets the UI label it
		// without any extractor-specific casing in the lower layers; threading the
		// extractor's input context as `prompt` shows what it was asked to work
		// from, just like a real subagent's prompt.
		o.dispatch({
			type: 'tool.call',
			toolCallId: toolCodec.encode(extractorParentId),
			tool: 'task',
			args: {
				name: 'Memory extractor',
				description: o.cardDescription,
				agent_type: 'memory-extractor',
				...(prompt ? { prompt } : {})
			}
		});
		o.dispatch({
			type: 'subagent.lifecycle',
			toolCallId: toolCodec.encode(extractorParentId),
			agentId: extractorAgentId,
			status: 'running'
		});
		return toolCodec.encode(extractorParentId);
	};
	const closeExtractorParent = (status: 'completed' | 'failed') => {
		if (extractorParentId && extractorAgentId) {
			o.dispatch({
				type: 'subagent.lifecycle',
				toolCallId: toolCodec.encode(extractorParentId),
				agentId: extractorAgentId,
				status
			});
		}
	};
	const onActivity = (activity: ExtractorActivity) => {
		if (abandoned) return;
		if (activity.type === 'input') {
			ensureExtractorParent(activity.text);
			return;
		}
		const parentToolCallId = ensureExtractorParent();
		switch (activity.type) {
			case 'tool.call':
				o.dispatch({
					type: 'tool.call',
					toolCallId: toolCodec.encode(activity.toolCallId),
					tool: activity.tool,
					args: activity.args,
					parentToolCallId
				});
				break;
			case 'tool.result':
				o.dispatch({
					type: 'tool.result',
					toolCallId: toolCodec.encode(activity.toolCallId),
					ok: activity.ok,
					summary: activity.summary,
					output: activity.output,
					parentToolCallId
				});
				break;
			case 'reasoning':
				o.dispatch({
					type: 'message.reasoning',
					messageId: o.assistantMessageId,
					segmentId: activity.segmentId,
					text: activity.text,
					parentToolCallId
				});
				break;
			case 'reasoning.end':
				o.dispatch({
					type: 'message.reasoning.end',
					messageId: o.assistantMessageId,
					segmentId: activity.segmentId,
					durationMs: activity.durationMs,
					parentToolCallId
				});
				break;
			case 'content':
				o.dispatch({
					type: 'message.delta',
					messageId: o.assistantMessageId,
					text: activity.text,
					parentToolCallId,
					segmentId: activity.segmentId
				});
				break;
		}
	};
	try {
		o.emit({
			type: 'memory.status',
			conversationId: convCodec.encode(o.conversationId),
			phase: 'extracting',
			summary: o.extractingSummary
		});
		const userMessage = {
			id: o.userMessageId,
			conversationId: convCodec.encode(o.conversationId),
			role: 'user',
			content: o.userContent,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		} as const;
		const assistantMessage = {
			id: o.assistantMessageId,
			conversationId: convCodec.encode(o.conversationId),
			role: 'assistant',
			content: o.assistantContent,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		} as const;
		o.emit({
			type: 'memory.status',
			conversationId: convCodec.encode(o.conversationId),
			phase: 'validating',
			summary: 'Validating durable memory patch.'
		});

		const committed = await runExtractionWithWatchdog(
			extractAndCommitMemory({
				conversationId: o.conversationId,
				userId: o.userId,
				mode: o.mode,
				turnId: o.turnId,
				userMessage,
				assistantMessage,
				onActivity,
				...(o.extractorModel !== undefined ? { extractorModel: o.extractorModel } : {}),
				...(o.beforeCommit !== undefined ? { beforeCommit: o.beforeCommit } : {}),
				...(o.priorPatchId !== undefined ? { priorPatchId: o.priorPatchId } : {}),
				signal: extractionAc.signal
			}),
			{
				turnAc: o.turnAc,
				extractionAc,
				cfg: o.cfg,
				onAbandon: () => {
					abandoned = true;
				}
			}
		);

		if (extractorParentId) {
			const spoken =
				committed.extraction.response?.trim() ||
				committed.patch.summary ||
				'Memory extraction complete.';
			o.dispatch({
				type: 'tool.result',
				toolCallId: toolCodec.encode(extractorParentId),
				ok: committed.patch.status !== 'needs_review',
				summary: committed.patch.summary || 'Memory extraction complete.',
				output: JSON.stringify({
					response: spoken,
					status: committed.patch.status,
					counts: committed.counts
				})
			});
			closeExtractorParent(committed.patch.status === 'needs_review' ? 'failed' : 'completed');
			extractorParentId = null;
		}
		o.emit({
			type: 'memory.status',
			conversationId: convCodec.encode(o.conversationId),
			phase: committed.patch.status === 'needs_review' ? 'needs_review' : 'committed',
			summary: committed.patch.summary || 'Memory patch processed.',
			patchId: committed.patch.id,
			counts: {
				events: committed.counts.events,
				facts: committed.counts.facts,
				openLoops: committed.counts.openLoops,
				issues: committed.counts.issues
			}
		});
	} catch (memoryErr) {
		// A user Stop aborts `turnAc`; a watchdog timeout (or a genuine extractor
		// error) does not. Only the former is a cancellation — timeouts and errors
		// are surfaced as `needs_review` failures.
		const aborted = isAbortError(memoryErr) || o.turnAc.signal.aborted;
		if (extractorParentId) {
			o.dispatch({
				type: 'tool.result',
				toolCallId: toolCodec.encode(extractorParentId),
				ok: false,
				summary: aborted ? 'Memory extraction cancelled.' : memoryFailureSummary(memoryErr),
				output: aborted ? o.cancelOutput : memoryFailureMessage(memoryErr)
			});
			closeExtractorParent('failed');
			extractorParentId = null;
		}
		if (aborted) {
			log.info(`${o.logPrefix}.aborted`, { conversationId: o.conversationId });
			o.emit({
				type: 'memory.status',
				conversationId: convCodec.encode(o.conversationId),
				phase: 'skipped',
				summary: 'Memory extraction cancelled.'
			});
		} else {
			log.warn(`${o.logPrefix}.failed`, {
				conversationId: o.conversationId,
				err: memoryFailureMessage(memoryErr),
				...memoryFailureLogFields(memoryErr)
			});
			o.emit({
				type: 'memory.status',
				conversationId: convCodec.encode(o.conversationId),
				phase: 'needs_review',
				summary: memoryFailureSummary(memoryErr)
			});
		}
	} finally {
		// Drop the turn→extraction abort link so it can't outlive the extraction
		// phase on a turn that finished without a Stop.
		o.turnAc.signal.removeEventListener('abort', linkExtractionAbort);
	}
}
