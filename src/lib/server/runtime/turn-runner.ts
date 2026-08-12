// Per-conversation "turn runner" that owns a single assistant turn.
//
// The runner consumes events from the underlying SDK session and:
//  - buffers them for any number of fan-out subscribers (replay + live),
//  - accumulates assistant text, tool calls, and file edits, and
//  - persists the assistant message at end of turn.
//
// Crucially, the runner's lifecycle is independent of any HTTP client:
// when the SSE consumer disconnects (e.g., the user refreshes the page),
// the runner keeps going so persistence is never lost. A subsequent GET
// can reattach and replay everything that already happened.

import { ulid } from 'ulid';
import { log } from '../log';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';
import * as messages from '../db/repos/messages';
import * as convs from '../db/repos/conversations';
import * as usageRepo from '../db/repos/usage';
import * as turnInputs from '../db/repos/turn-inputs';
import * as memory from '../db/repos/memory';
import * as pool from './pool';
import * as interactiveRequests from './interactive-requests';
import { publishConversationActivity } from './conversation-activity';
import { PORTAL_PRELUDE } from './portal-prelude';
import { AsyncQueue } from './async-queue';
import { snapshot as takeSnapshot } from '../snapshots';
import * as toolAttachments from '../db/repos/tool-attachments';
import { isEnabled } from '../memory/engine';
import { loadConfig } from '../config';
import { extractAndCommitMemory, MemoryExtractorHttpError } from '../memory/extractor';
import type { ExtractorActivity } from '../memory/extractor';
import type { MemoryExtractorBackend, MemoryMode } from '$lib/types';
import type { ProviderOpenOptions, ProviderSession } from '../pi/session-contract';
import { isPiMode } from '../pi';
import type { PortalEvent } from '$lib/types';

interface PendingTool {
	toolCallId: string;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
	parentToolCallId: string | null;
}

interface PendingReasoning {
	id: string;
	segmentIndex: number;
	text: string;
	kind: 'reasoning' | 'content';
	textOffset: number | null;
	startedAt: number;
	durationMs: number | null;
	parentToolCallId: string | null;
}

// Nudge used by the memory-mode continuation guard. Some models treat a single
// memory recall call as the whole turn — they query memory, then end without
// ever answering the user. When a memory-mode turn produces no user-facing text
// and the model itself only fired recall tools, we re-send this once so the
// model uses what it retrieved and actually responds.
const MEMORY_CONTINUATION_NUDGE =
	'You queried durable memory but have not yet answered me. A memory tool call is not a response, and I never see tool output directly. Using what you retrieved, respond to my message now. Do not end your turn without a substantive reply.';

// Read-only memory recall tools exposed to the model. Deliberately excludes
// write/mutation tools (memory_global_record, memory_merge_entities): a turn
// that *wrote* memory without answering is not the "recall then nothing"
// failure this guard targets, so it must not be nudged. Keep in sync with the
// recall tools advertised in memory/engine.ts.
const MEMORY_RECALL_TOOLS = new Set([
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
function isMemoryOnlyEmptyTurn(assistantText: string, tools: Map<string, PendingTool>): boolean {
	if (assistantText.trim().length > 0) return false;
	let sawTopLevelRecall = false;
	for (const t of tools.values()) {
		if (t.parentToolCallId !== null) continue;
		if (!MEMORY_RECALL_TOOLS.has(t.tool)) return false;
		sawTopLevelRecall = true;
	}
	return sawTopLevelRecall;
}

// A single event in the turn's transcript, paired with its monotonic id.
// `id` corresponds to the event's index in `eventLog`, which is what the
// SSE layer writes as `id:` and what clients send back as `Last-Event-ID`
// on reconnect.
export interface IdentifiedEvent {
	id: number;
	event: PortalEvent;
}

export interface SubscribeOptions {
	signal?: AbortSignal;
	// If provided, replay only events strictly after this id. Used by SSE
	// reconnects to skip what the client already received.
	sinceId?: number;
	// Used by fresh page loads that already rendered the persisted in-flight
	// message state from the DB. They only need future live events; replaying
	// buffered deltas would duplicate the already-rendered assistant content.
	skipReplay?: boolean;
}

export interface Turn {
	id: string;
	conversationId: string;
	startedAt: number;
	endedAt: number | null;
	status: 'running' | 'complete' | 'interrupted' | 'error';
	subscribe(opts?: SubscribeOptions): AsyncIterable<IdentifiedEvent>;
	abort(): Promise<void>;
}

interface InternalTurn extends Turn {
	eventLog: PortalEvent[];
	subscribers: Set<AsyncQueue<IdentifiedEvent>>;
	finishedPromise: Promise<void>;
}

// The turn registry is stashed on globalThis so that Vite HMR re-importing
// this module in dev does NOT wipe out the in-flight turns. Without this,
// a code edit during a turn would orphan the running turn in the old module
// closure: the new module's empty map would make `getTurn` return null, the
// client's resume-on-reload would get 204, and the UI would appear "stuck"
// with no assistant response while the orphaned turn quietly persisted to
// the DB minutes later. Same rationale as keeping the DB handle pinned.
const TURNS_KEYS = appGlobalSymbols('turns');
type TurnRegistry = Map<string, InternalTurn>;
const turns: TurnRegistry = getOrCreateGlobalSingleton(TURNS_KEYS, () => new Map());

// Tell the session pool that a conversation with a running turn is alive, so
// the idle reaper / capacity eviction don't dispose its SDK session mid-turn
// (e.g. while a long tool stream runs or while it's parked on a prompt — the
// pool also checks pending prompts directly). Registered by stable id so an
// HMR re-import replaces rather than duplicates the predicate. The optional
// call keeps partially-mocked `pool` modules (some unit tests) working.
pool.registerKeepAlive?.('turns.active', (conversationId) => {
	return turns.get(conversationId)?.status === 'running';
});

// Synchronous reservations that bridge the gap between a caller's "is a turn
// running?" guard and the moment `startTurn` actually registers the turn.
//
// In memory mode `startTurnFromUserMessage` does `await pool.release(...)`
// BEFORE calling `startTurn`, so the turn is not registered until after an
// await. Two concurrent POSTs could both pass a `getTurn` guard, both persist a
// user message, then race into `startTurn` — the loser threw a bare Error
// (surfaced as a 500) and left an orphaned user message with no turn. A caller
// takes a reservation synchronously (no intervening await) before doing any
// async setup; the reservation occupies the slot so a concurrent caller is
// rejected immediately and deterministically. Stashed on globalThis for the
// same HMR-survival reason as the turn registry.
const RESERVATIONS_KEYS = appGlobalSymbols('turn-reservations');
const reservations: Set<string> = getOrCreateGlobalSingleton(
	RESERVATIONS_KEYS,
	() => new Set<string>()
);

// Thrown when a turn is already running or reserved for a conversation. Typed
// so HTTP handlers can map it to a 409 (Conflict) instead of leaking a bare 500.
export class TurnAlreadyInProgressError extends Error {
	readonly conversationId: string;
	constructor(conversationId: string) {
		super('turn already in progress for this conversation');
		this.name = 'TurnAlreadyInProgressError';
		this.conversationId = conversationId;
	}
}

// True when a turn is actively running OR a synchronous reservation is held for
// the conversation. A finished-but-still-cached turn (grace window) does not
// count as active.
function isTurnActiveOrReserved(conversationId: string): boolean {
	return turns.get(conversationId)?.status === 'running' || reservations.has(conversationId);
}

// Synchronously claim the turn slot for a conversation. MUST be called with no
// intervening await between the caller's decision to start a turn and any
// async setup that precedes `startTurn`. Throws `TurnAlreadyInProgressError` if
// a turn is already running or reserved. Pair every successful call with
// `releaseTurnReservation` in a `finally`.
export function reserveTurn(conversationId: string): void {
	if (isTurnActiveOrReserved(conversationId)) {
		throw new TurnAlreadyInProgressError(conversationId);
	}
	reservations.add(conversationId);
}

// Release a reservation taken by `reserveTurn`. Safe to call even if no
// reservation is held (idempotent), so it can live in a `finally`.
export function releaseTurnReservation(conversationId: string): void {
	reservations.delete(conversationId);
}

// How long a finished turn lingers in the registry so that a slightly-late
// subscriber (e.g., a page that reloaded just as the turn completed) can
// still replay the full event log instead of missing it.
const FINISHED_GRACE_MS = 60_000;

export function getTurn(conversationId: string): Turn | null {
	return turns.get(conversationId) ?? null;
}

/**
 * Conversation ids with a turn actively running — the "agent is working" half
 * of the sidebar's active indicator. Excludes finished-but-still-cached turns
 * (the {@link FINISHED_GRACE_MS} window) and synchronous reservations, which
 * are an internal concurrency detail rather than an observable running turn.
 *
 * SINGLE-INSTANCE, like every other consumer of this registry.
 */
export function runningConversationIds(): Set<string> {
	const out = new Set<string>();
	for (const [conversationId, turn] of turns) {
		if (turn.status === 'running') out.add(conversationId);
	}
	return out;
}

// Look up a turn by its own id (the ulid in `turn.id`), scoped to a
// conversation. Used by the streaming endpoint, which keys URLs by
// `turnId` so reconnects always land on the same logical stream even
// if a new turn replaced the registry slot.
export function getTurnById(conversationId: string, turnId: string): Turn | null {
	const t = turns.get(conversationId);
	return t && t.id === turnId ? t : null;
}

export interface StartTurnOptions {
	bridge: ProviderOpenOptions;
	prompt: string;
	conversationId: string;
	// The user message that triggered this turn. When provided, the full
	// assembled provider input (prelude + prompt) is captured against it so the
	// UI can inspect "the guts" of the turn later.
	userMessageId?: string | undefined;
	beforeSend?: (() => Promise<void>) | undefined;
	initialEvents?: PortalEvent[] | undefined;
	memory?:
		| {
				mode: MemoryMode;
				userMessageId: string;
				userContent: string;
				extractorModel?: string | null | undefined;
				extractorBackend?: MemoryExtractorBackend | null | undefined;
		  }
		| undefined;
}

// Tear down a session in response to a user Stop. `abort()` asks the SDK to
// unwind its active stream gracefully, but a subprocess wedged in I/O can leave
// that promise pending forever. We race it against TURN_ABORT_FINALIZE_DEADLINE_MS
// and, on timeout, escalate to `dispose()` (force kill the subprocess) so a
// wedged session can't be orphaned. Fire-and-forget by design: the turn already
// finalizes off the abort signal regardless of how this settles, so all failure
// paths only log.
async function abortSessionWithDeadline(
	session: Pick<ProviderSession, 'abort' | 'dispose'>,
	conversationId: string
): Promise<void> {
	const deadlineMs = loadConfig().TURN_ABORT_FINALIZE_DEADLINE_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), deadlineMs);
		(timer as { unref?: () => void }).unref?.();
	});
	const aborted = session.abort().then(
		() => 'aborted' as const,
		(err) => {
			log.warn('turn.session.abort_failed', {
				conversationId,
				err: err instanceof Error ? err.message : String(err)
			});
			return 'aborted' as const;
		}
	);
	try {
		const outcome = await Promise.race([aborted, timedOut]);
		if (outcome === 'timeout') {
			log.warn('turn.session.abort_timeout', { conversationId, deadlineMs });
			try {
				await session.dispose();
				log.info('turn.session.force_disposed', { conversationId });
			} catch (err) {
				log.warn('turn.session.dispose_failed', {
					conversationId,
					err: err instanceof Error ? err.message : String(err)
				});
			}
		}
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function startTurn(opts: StartTurnOptions): Promise<Turn> {
	const existing = turns.get(opts.conversationId);
	if (existing && existing.status === 'running') {
		throw new TurnAlreadyInProgressError(opts.conversationId);
	}
	if (existing) {
		// Replace a finished-but-still-cached turn with the new one.
		turns.delete(opts.conversationId);
	}

	const eventLog: PortalEvent[] = [];
	const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
	const turnAc = new AbortController();
	let session: Awaited<ReturnType<typeof pool.acquire>> | null = null;

	// Append an event to the log and fan it out to live subscribers with
	// its monotonic id (= index in `eventLog`). All paths that need to
	// surface an event MUST go through here so that ids stay contiguous
	// and aligned with the replay buffer.
	function emit(ev: PortalEvent) {
		// Live-only events (per-tool partial output, progress messages):
		// fan out to active subscribers but do NOT append to the event log.
		// Reconnects don't replay them; the authoritative final state comes
		// from `tool.result`.
		if (ev.type === 'tool.partial_output' || ev.type === 'tool.progress') {
			const wrapped: IdentifiedEvent = { id: -1, event: ev };
			for (const q of subscribers) q.push(wrapped);
			return;
		}
		const id = eventLog.length;
		eventLog.push(ev);
		const wrapped: IdentifiedEvent = { id, event: ev };
		for (const q of subscribers) q.push(wrapped);
	}

	const turn: InternalTurn = {
		id: ulid(),
		conversationId: opts.conversationId,
		startedAt: Date.now(),
		endedAt: null,
		status: 'running',
		eventLog,
		subscribers,
		finishedPromise: undefined as unknown as Promise<void>,
		subscribe(subOpts?: SubscribeOptions) {
			return subscribe(turn, subOpts);
		},
		async abort() {
			turnAc.abort();
			interactiveRequests.cancelConversation(opts.conversationId, 'turn_aborted');
			// Do NOT await session.abort(): if the underlying session is wedged,
			// awaiting here would block the DELETE handler (and any caller) until
			// it unwinds. Aborting the turn signal already tears down the active
			// stream and arms the extraction watchdog, so the turn is guaranteed
			// to finalize regardless of how long the session takes to settle.
			// The fire-and-forget teardown races abort() against a deadline and
			// escalates to a force-dispose if abort() hangs, so a wedged SDK
			// subprocess can't be orphaned (leaking fds/memory) while the turn
			// finalizes as if it had succeeded.
			const sessionToAbort = session;
			if (sessionToAbort) {
				void abortSessionWithDeadline(sessionToAbort, opts.conversationId);
			}
		}
	};

	turns.set(opts.conversationId, turn);
	publishConversationActivity(opts.bridge.userId, opts.conversationId, true);
	for (const ev of opts.initialEvents ?? []) emit(ev);

	// Accumulators for persistence.
	let assistantBuf = '';
	let assistantId: string | null = null;
	let persistedAssistantId: string | null = null;
	// Set to an error code when the stream fails for a non-abort reason
	// (network drop, SDK crash, rate-limit). Drives the terminal `status` to
	// `'error'` so the failed turn is persisted and reported as such rather
	// than a false `'complete'`. `null` means no stream failure.
	let streamErrorCode: string | null = null;
	const pendingTools = new Map<string, PendingTool>();
	// Reasoning segments keyed by the segmentId minted in the bridge. Order
	// of insertion matches stream order, which is what we persist.
	const pendingReasoning = new Map<string, PendingReasoning>();
	const persistedFileEditKeys = new Set<string>();
	let nextReasoningIndex = 0;

	function ensurePersistedAssistant(): string {
		if (persistedAssistantId) return persistedAssistantId;
		const persisted = messages.append(opts.conversationId, {
			role: 'assistant',
			content: assistantBuf,
			status: 'streaming'
		});
		persistedAssistantId = persisted.id;
		return persisted.id;
	}

	function dispatch(ev: PortalEvent) {
		// Suppress the SDK's `done` event: we always emit our own terminal
		// `done` in the finally block after persistence work completes.
		if (ev.type === 'done') return;

		if (ev.type === 'message.start') {
			assistantId = ev.messageId;
			emit({ ...ev, messageId: ensurePersistedAssistant() });
		} else if (ev.type === 'message.delta') {
			const persistedId = ensurePersistedAssistant();
			if (ev.parentToolCallId && ev.segmentId) {
				// Sub-agent content: thread it into the spawning card as a
				// 'content' block instead of appending to the outer message body,
				// so a nested agent renders its response interleaved with its
				// tools/reasoning. Accumulated by segmentId like reasoning.
				let seg = pendingReasoning.get(ev.segmentId);
				if (!seg) {
					seg = {
						id: ev.segmentId,
						segmentIndex: nextReasoningIndex++,
						text: '',
						kind: 'content',
						textOffset: null,
						startedAt: Date.now(),
						durationMs: null,
						parentToolCallId: ev.parentToolCallId
					};
					pendingReasoning.set(ev.segmentId, seg);
				}
				seg.text += ev.text;
				messages.upsertReasoningBlock(persistedId, seg);
				emit({ ...ev, messageId: persistedId });
			} else {
				assistantBuf += ev.text;
				messages.updateContentOnly(persistedId, assistantBuf);
				emit({ ...ev, messageId: persistedId });
			}
		} else if (ev.type === 'message.reasoning') {
			const persistedId = ensurePersistedAssistant();
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				const isChild = !!ev.parentToolCallId;
				seg = {
					id: ev.segmentId,
					segmentIndex: nextReasoningIndex++,
					text: '',
					kind: 'reasoning',
					// Child reasoning isn't anchored to the outer assistant text;
					// it's rendered inside the SubagentCall card instead.
					textOffset: isChild ? null : assistantBuf.length,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: ev.parentToolCallId ?? null
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(persistedId, seg);
			emit({ ...ev, messageId: persistedId });
		} else if (ev.type === 'message.reasoning.end') {
			const seg = pendingReasoning.get(ev.segmentId);
			const persistedId = ensurePersistedAssistant();
			if (seg) {
				seg.durationMs = ev.durationMs;
				messages.upsertReasoningBlock(persistedId, seg);
			}
			emit({ ...ev, messageId: persistedId });
		} else if (ev.type === 'message.end') {
			emit({ ...ev, messageId: ensurePersistedAssistant() });
		} else if (ev.type === 'tool.call') {
			const isChild = !!ev.parentToolCallId;
			const persistedId = ensurePersistedAssistant();
			emit({ ...ev, messageId: persistedId });
			const tool: PendingTool = {
				toolCallId: ev.toolCallId,
				tool: ev.tool,
				argsJson: safeJson(ev.args),
				resultJson: null,
				status: 'pending',
				startedAt: Date.now(),
				endedAt: null,
				textOffset: isChild ? null : assistantBuf.length,
				parentToolCallId: ev.parentToolCallId ?? null
			};
			pendingTools.set(ev.toolCallId, tool);
			messages.upsertToolCall(persistedId, {
				id: tool.toolCallId,
				tool: tool.tool,
				argsJson: tool.argsJson,
				resultJson: tool.resultJson,
				status: tool.status,
				startedAt: tool.startedAt,
				endedAt: tool.endedAt,
				textOffset: tool.textOffset,
				parentToolCallId: tool.parentToolCallId
			});
		} else if (ev.type === 'tool.result') {
			// Surface any image attachments captured + flushed for this call so
			// the live card can render them without waiting for a reload.
			const attachments = toolAttachments.listMetaForToolCall(ev.toolCallId);
			emit(attachments.length > 0 ? { ...ev, attachments } : ev);
			const tc = pendingTools.get(ev.toolCallId);
			if (tc) {
				tc.status = ev.ok ? 'ok' : 'error';
				tc.resultJson = safeJson(ev.output ?? ev.summary);
				tc.endedAt = Date.now();
				messages.updateToolCall(ev.toolCallId, {
					status: tc.status,
					resultJson: tc.resultJson,
					endedAt: tc.endedAt
				});
			}
		} else if (ev.type === 'subagent.lifecycle') {
			emit(ev);
			messages.updateBackgroundAgentLifecycle(ev.toolCallId, ev.agentId, ev.status);
		} else if (ev.type === 'file.edit') {
			const isChild = !!ev.parentToolCallId;
			const persistedId = ensurePersistedAssistant();
			emit({ ...ev, messageId: persistedId });
			const textOffset = isChild ? null : assistantBuf.length;
			const parentToolCallId = ev.parentToolCallId ?? null;
			const key = JSON.stringify([ev.path, ev.diff, textOffset, parentToolCallId]);
			if (!persistedFileEditKeys.has(key)) {
				persistedFileEditKeys.add(key);
				messages.insertFileEdit(
					ensurePersistedAssistant(),
					ev.path,
					ev.diff,
					textOffset,
					parentToolCallId
				);
			}
		} else if (ev.type === 'context.usage') {
			emit(ev);
			try {
				usageRepo.upsert(opts.conversationId, {
					currentTokens: ev.currentTokens,
					tokenLimit: ev.tokenLimit,
					messagesLength: ev.messagesLength,
					systemTokens: ev.systemTokens ?? null,
					conversationTokens: ev.conversationTokens ?? null,
					toolDefinitionsTokens: ev.toolDefinitionsTokens ?? null
				});
			} catch (usageErr) {
				log.warn('turn.usage.persist_failed', {
					conversationId: opts.conversationId,
					err: String(usageErr)
				});
			}
		} else {
			emit(ev);
		}
	}

	// Prepend a portal-context block telling the agent it's running through
	// a permission gateway and that reject `feedback` is authoritative.
	// The user's message itself is preserved verbatim after the block;
	// this only changes what the agent sees, not what we persist (the raw
	// user content was already stored by the turns route before we got
	// here).
	//
	// Skip in stub mode: the deterministic test stub echoes whatever it
	// receives, so dumping the prelude into its reply breaks tests that
	// assert on the literal user prompt and wastes tokens against a
	// fixed-string responder that wouldn't act on the guidance anyway.
	const prelude = isPiMode() ? '' : PORTAL_PRELUDE;
	const promptToSend = prelude ? `${prelude}\n\n${opts.prompt}` : opts.prompt;

	// Capture the exact provider input for this turn so the UI can surface it
	// read-only (portal prelude + memory/prior-message context + user content).
	// Best-effort: never let an observability write break the turn.
	if (opts.userMessageId) {
		try {
			turnInputs.record({
				messageId: opts.userMessageId,
				conversationId: opts.conversationId,
				turnId: turn.id,
				fullInput: promptToSend,
				promptBody: opts.prompt,
				prelude,
				model: opts.bridge.model ?? null,
				mode: opts.bridge.mode ?? null,
				memoryMode: opts.bridge.memoryMode ?? null,
				initialMessages:
					opts.bridge.initialMessages?.map((m) => ({
						role: m.role,
						content: m.content
					})) ?? null
			});
		} catch (recordErr) {
			log.warn('turn.input.record_failed', {
				conversationId: opts.conversationId,
				err: String(recordErr)
			});
		}
	}

	turn.finishedPromise = (async () => {
		try {
			await opts.beforeSend?.();
			session = await pool.acquire(opts.bridge);
			if (turnAc.signal.aborted) {
				// Same wedge hazard as turn.abort(): a bare `await session.abort()`
				// would hang `finishedPromise` (and thus turn cleanup) forever if the
				// SDK subprocess is stuck in I/O. Bound it with the deadline helper so a
				// stuck abort escalates to a force-dispose instead of orphaning the turn.
				await abortSessionWithDeadline(session, opts.conversationId);
				return;
			}
			for await (const ev of session.send(promptToSend, turnAc.signal)) {
				dispatch(ev);
			}
			// Memory-mode "tool call then nothing" guard: if the model only
			// fired recall tools and produced no user-facing text, nudge it
			// once to answer using what it retrieved. The provider session
			// retains the prior tool calls/results, so this continues in
			// context. Bounded to a single retry to avoid loops.
			if (
				!turnAc.signal.aborted &&
				opts.memory &&
				isEnabled(opts.memory.mode) &&
				isMemoryOnlyEmptyTurn(assistantBuf, pendingTools)
			) {
				log.info('turn.memory.continuation_nudge', {
					conversationId: opts.conversationId,
					toolCalls: pendingTools.size
				});
				for await (const ev of session.send(MEMORY_CONTINUATION_NUDGE, turnAc.signal)) {
					dispatch(ev);
				}
				// The nudge is bounded to one retry. If the continuation still
				// produced no user-facing text, the turn finalizes without an
				// answer — surface that so the failure mode is observable
				// rather than silently swallowed.
				if (!turnAc.signal.aborted && isMemoryOnlyEmptyTurn(assistantBuf, pendingTools)) {
					log.warn('turn.memory.continuation_nudge_unanswered', {
						conversationId: opts.conversationId,
						toolCalls: pendingTools.size
					});
				}
			}
		} catch (e) {
			if (turnAc.signal.aborted) return;
			streamErrorCode = 'stream_failed';
			log.warn('turn.stream.failed', {
				conversationId: opts.conversationId,
				err: String(e)
			});
			dispatch({
				type: 'error',
				code: 'stream_failed',
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			const status: 'interrupted' | 'complete' | 'error' = turnAc.signal.aborted
				? 'interrupted'
				: streamErrorCode
					? 'error'
					: 'complete';

			try {
				if (persistedAssistantId || assistantBuf || assistantId || pendingTools.size) {
					const id = ensurePersistedAssistant();
					messages.updateContent(id, assistantBuf, status, streamErrorCode);
					for (const t of pendingTools.values()) {
						if (t.status === 'pending') {
							t.status = 'error';
							t.endedAt = Date.now();
							messages.updateToolCall(t.toolCallId, {
								resultJson: t.resultJson,
								status: t.status,
								endedAt: t.endedAt
							});
						}
					}
				}
				convs.touch(opts.conversationId);
			} catch (persistErr) {
				log.error('turn.persist.failed', {
					conversationId: opts.conversationId,
					err: String(persistErr)
				});
			}

			// Post-turn workdir snapshot, bound to the assistant message
			// id. Used by "fork after this reply" affordances and for
			// post-turn diff views. Non-fatal on failure.
			if (persistedAssistantId) {
				try {
					await takeSnapshot(opts.bridge.workingDirectory, persistedAssistantId, 'post');
				} catch (snapErr) {
					log.warn('snapshot.post.failed', {
						conversationId: opts.conversationId,
						messageId: persistedAssistantId,
						err: String(snapErr)
					});
				}
			}

			if (
				persistedAssistantId &&
				status === 'complete' &&
				opts.memory &&
				isEnabled(opts.memory.mode)
			) {
				const cfg = loadConfig();
				await runMemoryExtractionCard({
					emit,
					dispatch,
					turnAc,
					cfg,
					conversationId: opts.conversationId,
					userId: opts.bridge.userId,
					assistantMessageId: persistedAssistantId,
					assistantContent: assistantBuf,
					userMessageId: opts.memory.userMessageId,
					userContent: opts.memory.userContent,
					mode: opts.memory.mode,
					extractorModel: opts.memory.extractorModel,
					extractorBackend: opts.memory.extractorBackend,
					turnId: turn.id,
					cardDescription: 'Memory extraction',
					extractingSummary: 'Extracting durable memory updates.',
					logPrefix: 'turn.memory',
					cancelOutput: 'Cancelled by user.'
				});
			}

			// A Stop issued while the post-turn extractor was still running aborts
			// the turn signal after `status` was computed as `complete`; reflect
			// that late interrupt so the turn ends `interrupted`.
			turn.status = turnAc.signal.aborted ? 'interrupted' : status;
			turn.endedAt = Date.now();
			// The turn is no longer running; the assistant message (if any) is
			// persisted by now, so `unread` resolves correctly for the sidebar.
			publishConversationActivity(opts.bridge.userId, opts.conversationId, false);
			// We always emit our own terminal `done` here: `dispatch` suppresses
			// the SDK's `done` so this runs after persistence work completes. We
			// carry the terminal status so clients can distinguish a clean finish
			// from an interrupt/abort or a hard stream failure (`'error'`, which
			// also emits an `error` event). The `some` check is a defensive guard
			// against a double terminal event in case a future change ever
			// re-emits the SDK `done` into the log.
			if (!eventLog.some((e) => e.type === 'done')) {
				emit({ type: 'done', status: turn.status });
			}
			for (const q of subscribers) q.end();
			subscribers.clear();

			// Keep the finished turn around briefly so that a subscriber that
			// races with completion still gets the full replay.
			const t = setTimeout(() => {
				if (turns.get(opts.conversationId) === turn) {
					turns.delete(opts.conversationId);
				}
			}, FINISHED_GRACE_MS);
			(t as { unref?: () => void }).unref?.();
		}
	})();

	return turn;
}

async function* subscribe(
	turn: InternalTurn,
	opts: SubscribeOptions = {}
): AsyncIterable<IdentifiedEvent> {
	const { signal, sinceId } = opts;

	// Replay buffered events from (sinceId, end]. `sinceId` is the last id
	// the client successfully received — we resume from sinceId+1. If
	// undefined, send everything from the start.
	// Note: the for-loop reads turn.eventLog.length each iteration, so any
	// events appended by dispatch between yields are picked up before we
	// fall through to the live subscription. No gap, no duplicates.
	const startIdx = opts.skipReplay ? turn.eventLog.length : sinceId === undefined ? 0 : sinceId + 1;
	for (let i = startIdx; i < turn.eventLog.length; i++) {
		if (signal?.aborted) return;
		yield { id: i, event: turn.eventLog[i] };
	}

	// If the turn already finished, we're done after the replay.
	if (turn.status !== 'running') {
		// `skipReplay` starts at the end of the log, so on an already-finished
		// turn the loop above yields nothing and the subscriber would otherwise
		// receive no events — forcing it to infer completion from silence.
		// Replay the terminal `done` (always the last log entry once a turn
		// finishes) so every subscriber gets an explicit terminal signal
		// regardless of attach timing.
		if (opts.skipReplay && !signal?.aborted) {
			const lastIdx = turn.eventLog.length - 1;
			if (lastIdx >= 0 && turn.eventLog[lastIdx].type === 'done') {
				yield { id: lastIdx, event: turn.eventLog[lastIdx] };
			}
		}
		return;
	}

	// Subscribe to live events. Adding q to `subscribers` is synchronous
	// with the loop exit above (no awaits between them), so dispatch can't
	// slip an event in unobserved.
	const q = new AsyncQueue<IdentifiedEvent>();
	turn.subscribers.add(q);

	const onAbort = () => {
		// Unsubscribe only; do NOT cancel the turn.
		turn.subscribers.delete(q);
		q.end();
	};
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	try {
		for await (const ev of q) {
			yield ev;
		}
	} finally {
		signal?.removeEventListener('abort', onAbort);
		turn.subscribers.delete(q);
	}
}

function safeJson(v: unknown): string {
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
	if (!(err instanceof MemoryExtractorHttpError)) return {};
	return {
		extractorStatus: err.status,
		extractorStatusText: err.statusText,
		extractorEndpoint: err.endpoint,
		extractorModel: err.model,
		extractorProviderMessage: err.providerMessage,
		extractorResponseBodyExcerpt: err.responseBodyExcerpt
	};
}

// A compact `dispatch` for the memory-extraction retry path. Unlike the full
// turn `dispatch`, it never appends a new assistant message: the retry re-runs
// extraction for an *existing* assistant message, so the extractor's subagent
// card (and its threaded reasoning/content/tool activity) is persisted onto
// that message id. It handles exactly the event subset the extractor emits and
// mirrors the persistence the full `dispatch` performs for those events so the
// retry card survives reloads and appears in history just like a post-turn one.
function makeExtractorCardDispatch(
	emit: (ev: PortalEvent) => void,
	assistantMessageId: string
): (ev: PortalEvent) => void {
	const pendingReasoning = new Map<string, PendingReasoning>();
	let nextReasoningIndex = 0;
	return (ev: PortalEvent) => {
		if (ev.type === 'tool.call') {
			emit({ ...ev, messageId: assistantMessageId });
			messages.upsertToolCall(assistantMessageId, {
				id: ev.toolCallId,
				tool: ev.tool,
				argsJson: safeJson(ev.args),
				resultJson: null,
				status: 'pending',
				startedAt: Date.now(),
				endedAt: null,
				textOffset: null,
				parentToolCallId: ev.parentToolCallId ?? null
			});
		} else if (ev.type === 'tool.result') {
			emit(ev);
			messages.updateToolCall(ev.toolCallId, {
				status: ev.ok ? 'ok' : 'error',
				resultJson: safeJson(ev.output ?? ev.summary),
				endedAt: Date.now()
			});
		} else if (ev.type === 'subagent.lifecycle') {
			emit(ev);
			messages.updateBackgroundAgentLifecycle(ev.toolCallId, ev.agentId, ev.status);
		} else if (ev.type === 'message.reasoning') {
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				seg = {
					id: ev.segmentId,
					segmentIndex: nextReasoningIndex++,
					text: '',
					kind: 'reasoning',
					textOffset: null,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: ev.parentToolCallId ?? null
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(assistantMessageId, seg);
			emit({ ...ev, messageId: assistantMessageId });
		} else if (ev.type === 'message.reasoning.end') {
			const seg = pendingReasoning.get(ev.segmentId);
			if (seg) {
				seg.durationMs = ev.durationMs;
				messages.upsertReasoningBlock(assistantMessageId, seg);
			}
			emit({ ...ev, messageId: assistantMessageId });
		} else if (ev.type === 'message.delta' && ev.parentToolCallId && ev.segmentId) {
			let seg = pendingReasoning.get(ev.segmentId);
			if (!seg) {
				seg = {
					id: ev.segmentId,
					segmentIndex: nextReasoningIndex++,
					text: '',
					kind: 'content',
					textOffset: null,
					startedAt: Date.now(),
					durationMs: null,
					parentToolCallId: ev.parentToolCallId
				};
				pendingReasoning.set(ev.segmentId, seg);
			}
			seg.text += ev.text;
			messages.upsertReasoningBlock(assistantMessageId, seg);
			emit({ ...ev, messageId: assistantMessageId });
		} else {
			emit(ev);
		}
	};
}

interface MemoryExtractionCardOptions {
	emit: (ev: PortalEvent) => void;
	// Routes the extractor's parent card + threaded children through whichever
	// persistence path the caller owns: the full turn `dispatch` (post-turn) or
	// `makeExtractorCardDispatch` (retry, which writes onto an existing message).
	dispatch: (ev: PortalEvent) => void;
	// User-Stop signal for the owning turn. Linked to a dedicated extraction
	// signal that also fires on a watchdog trip.
	turnAc: AbortController;
	cfg: ReturnType<typeof loadConfig>;
	conversationId: string;
	userId: string;
	// The assistant message the extractor card is attached to; its content is the
	// turn's assistant response (reused verbatim — never regenerated here).
	assistantMessageId: string;
	assistantContent: string;
	userMessageId: string;
	userContent: string;
	mode: MemoryMode;
	extractorModel?: string | null | undefined;
	extractorBackend?: MemoryExtractorBackend | null | undefined;
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
	priorPatchId?: string | null | undefined;
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
async function runMemoryExtractionCard(o: MemoryExtractionCardOptions): Promise<void> {
	// Created lazily on the first activity event so extractors that emit nothing
	// (heuristic / single-shot JSON) never spawn an empty card. Declared out here
	// so the catch below can close the card if extraction throws.
	let extractorParentId: string | null = null;
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
		if (extractorParentId) return extractorParentId;
		extractorParentId = `mem_parent_${ulid()}`;
		extractorAgentId = `mem_agent_${ulid()}`;
		// Emit the same event shape as a real subagent: a `task` tool call plus a
		// `subagent.lifecycle` start. The `agent_type` arg lets the UI label it
		// without any extractor-specific casing in the lower layers; threading the
		// extractor's input context as `prompt` shows what it was asked to work
		// from, just like a real subagent's prompt.
		o.dispatch({
			type: 'tool.call',
			toolCallId: extractorParentId,
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
			toolCallId: extractorParentId,
			agentId: extractorAgentId,
			status: 'running'
		});
		return extractorParentId;
	};
	const closeExtractorParent = (status: 'completed' | 'failed') => {
		if (extractorParentId && extractorAgentId) {
			o.dispatch({
				type: 'subagent.lifecycle',
				toolCallId: extractorParentId,
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
					toolCallId: activity.toolCallId,
					tool: activity.tool,
					args: activity.args,
					parentToolCallId
				});
				break;
			case 'tool.result':
				o.dispatch({
					type: 'tool.result',
					toolCallId: activity.toolCallId,
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
			conversationId: o.conversationId,
			phase: 'extracting',
			summary: o.extractingSummary
		});
		const userMessage = {
			id: o.userMessageId,
			conversationId: o.conversationId,
			role: 'user',
			content: o.userContent,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		} as const;
		const assistantMessage = {
			id: o.assistantMessageId,
			conversationId: o.conversationId,
			role: 'assistant',
			content: o.assistantContent,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		} as const;
		o.emit({
			type: 'memory.status',
			conversationId: o.conversationId,
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
				...(o.extractorBackend !== undefined ? { extractorBackend: o.extractorBackend } : {}),
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
				toolCallId: extractorParentId,
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
			conversationId: o.conversationId,
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
				toolCallId: extractorParentId,
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
				conversationId: o.conversationId,
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
				conversationId: o.conversationId,
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

export interface StartExtractionRetryOptions {
	conversationId: string;
	userId: string;
	// The existing assistant message whose extraction is being re-run. Its
	// content is reused verbatim — the assistant response is NOT regenerated.
	assistantMessageId: string;
	assistantContent: string;
	memory: {
		mode: MemoryMode;
		userMessageId: string;
		userContent: string;
		extractorModel?: string | null;
		extractorBackend?: MemoryExtractorBackend | null;
		// Stable turn id used for the committed patch so repeated retries of the
		// same logical turn keep grouping under one turn id (the prior-patch
		// lookup keys off it). Defaults to the retry turn's own id when absent.
		patchTurnId?: string | null;
		// The prior committed patch to undo as part of this retry. The undo is
		// deferred until extraction succeeds (see `beforeCommit`), so a
		// failed/timed-out/aborted retry preserves the existing memory. Null
		// when the prior turn committed nothing to undo.
		priorPatchId?: string | null;
	};
}

/**
 * Re-run *only* the memory-extraction step for the latest assistant turn,
 * reusing the stored user + assistant messages. No provider session is opened,
 * the model is not re-prompted, and no new message is appended. The extractor's
 * subagent card and `memory.status` events are emitted through the same turn /
 * SSE machinery as a normal post-turn extraction, so the live card and inspector
 * update identically.
 *
 * Undoing the prior patch (`memory.priorPatchId`) is deferred until the
 * extraction has produced a committable patch — it runs immediately before the
 * new commit. A failed, timed-out, or aborted retry therefore leaves the
 * previously committed memory intact instead of destroying it.
 */
export async function startExtractionRetryTurn(opts: StartExtractionRetryOptions): Promise<Turn> {
	const existing = turns.get(opts.conversationId);
	if (existing && existing.status === 'running') {
		throw new TurnAlreadyInProgressError(opts.conversationId);
	}
	if (existing) turns.delete(opts.conversationId);

	const eventLog: PortalEvent[] = [];
	const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
	const turnAc = new AbortController();

	function emit(ev: PortalEvent) {
		if (ev.type === 'tool.partial_output' || ev.type === 'tool.progress') {
			const wrapped: IdentifiedEvent = { id: -1, event: ev };
			for (const q of subscribers) q.push(wrapped);
			return;
		}
		const id = eventLog.length;
		eventLog.push(ev);
		const wrapped: IdentifiedEvent = { id, event: ev };
		for (const q of subscribers) q.push(wrapped);
	}

	const turn: InternalTurn = {
		id: ulid(),
		conversationId: opts.conversationId,
		startedAt: Date.now(),
		endedAt: null,
		status: 'running',
		eventLog,
		subscribers,
		finishedPromise: undefined as unknown as Promise<void>,
		subscribe(subOpts?: SubscribeOptions) {
			return subscribe(turn, subOpts);
		},
		async abort() {
			turnAc.abort();
		}
	};

	turns.set(opts.conversationId, turn);
	publishConversationActivity(opts.userId, opts.conversationId, true);

	const dispatch = makeExtractorCardDispatch(emit, opts.assistantMessageId);
	const cfg = loadConfig();

	turn.finishedPromise = (async () => {
		// Undo the prior committed patch only once a replacement patch has
		// validated and is about to be applied (invoked by `commitPatch`, which
		// `extractAndCommitMemory` forwards `beforeCommit` to). If extraction
		// fails, times out, aborts, or yields a `needs_review` patch, this never
		// runs and the existing committed memory is preserved.
		//
		// `revertCommittedPatch` deletes what the patch created, reopens the loops
		// it resolved, restores the facts it forgot, then rebuilds the projection
		// so the active set — including supersede/dedupe — is re-derived from the
		// event log rather than hand-maintained. The patch row itself is left
		// intact, preserving history. (The re-extraction's pre-run packet view is
		// produced separately, by replaying the log forward to the turn's
		// branch-point head — see `readMemoryAtTurnStart`.)
		const priorPatchId = opts.memory.priorPatchId;
		const beforeCommit = priorPatchId
			? () => memory.revertCommittedPatch(opts.conversationId, priorPatchId)
			: undefined;

		try {
			await runMemoryExtractionCard({
				emit,
				dispatch,
				turnAc,
				cfg,
				conversationId: opts.conversationId,
				userId: opts.userId,
				assistantMessageId: opts.assistantMessageId,
				assistantContent: opts.assistantContent,
				userMessageId: opts.memory.userMessageId,
				userContent: opts.memory.userContent,
				mode: opts.memory.mode,
				extractorModel: opts.memory.extractorModel,
				extractorBackend: opts.memory.extractorBackend,
				turnId: opts.memory.patchTurnId ?? turn.id,
				cardDescription: 'Memory extraction (retry)',
				extractingSummary: 'Re-extracting durable memory updates.',
				logPrefix: 'memory.retry',
				cancelOutput: 'Cancelled.',
				beforeCommit,
				priorPatchId
			});
		} finally {
			try {
				convs.touch(opts.conversationId);
			} catch (touchErr) {
				log.warn('memory.retry.touch_failed', {
					conversationId: opts.conversationId,
					err: String(touchErr)
				});
			}
			turn.status = turnAc.signal.aborted ? 'interrupted' : 'complete';
			turn.endedAt = Date.now();
			publishConversationActivity(opts.userId, opts.conversationId, false);
			if (!eventLog.some((e) => e.type === 'done')) {
				emit({ type: 'done', status: turn.status === 'interrupted' ? 'interrupted' : 'complete' });
			}
			for (const q of subscribers) q.end();
			subscribers.clear();
			const t = setTimeout(() => {
				if (turns.get(opts.conversationId) === turn) turns.delete(opts.conversationId);
			}, FINISHED_GRACE_MS);
			(t as { unref?: () => void }).unref?.();
		}
	})();

	return turn;
}
