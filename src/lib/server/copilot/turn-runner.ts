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
import * as pool from './pool';
import * as interactiveRequests from './interactive-requests';
import { PORTAL_PRELUDE } from './portal-prelude';
import { isStubMode } from './bridge-stub';
import { AsyncQueue } from '../runtime/async-queue';
import { snapshot as takeSnapshot } from '../snapshots';
import { isEnabled } from '../memory/engine';
import { extractAndCommitMemory, MemoryExtractorHttpError } from '../memory/extractor';
import type { ExtractorActivity } from '../memory/extractor';
import type { MemoryMode } from '$lib/types';
import type { ProviderOpenOptions } from '../providers';
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

// How long a finished turn lingers in the registry so that a slightly-late
// subscriber (e.g., a page that reloaded just as the turn completed) can
// still replay the full event log instead of missing it.
const FINISHED_GRACE_MS = 60_000;

export function getTurn(conversationId: string): Turn | null {
	return turns.get(conversationId) ?? null;
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
	userMessageId?: string;
	beforeSend?: () => Promise<void>;
	initialEvents?: PortalEvent[];
	memory?: {
		mode: MemoryMode;
		userMessageId: string;
		userContent: string;
		extractorModel?: string | null;
	};
}

export async function startTurn(opts: StartTurnOptions): Promise<Turn> {
	const existing = turns.get(opts.conversationId);
	if (existing && existing.status === 'running') {
		throw new Error('turn already in progress for this conversation');
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
			try {
				await session?.abort();
			} catch {
				/* ignore */
			}
		}
	};

	turns.set(opts.conversationId, turn);
	for (const ev of opts.initialEvents ?? []) emit(ev);

	// Accumulators for persistence.
	let assistantBuf = '';
	let assistantId: string | null = null;
	let persistedAssistantId: string | null = null;
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
			emit(ev);
			const isChild = !!ev.parentToolCallId;
			const persistedId = ensurePersistedAssistant();
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
			emit(ev);
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
			emit(ev);
			const isChild = !!ev.parentToolCallId;
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
					systemTokens: ev.systemTokens,
					conversationTokens: ev.conversationTokens,
					toolDefinitionsTokens: ev.toolDefinitionsTokens
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
	const prelude = isStubMode() ? '' : PORTAL_PRELUDE;
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
				provider: opts.bridge.provider ?? null,
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
				await session.abort();
				return;
			}
			for await (const ev of session.send(promptToSend, turnAc.signal)) {
				dispatch(ev);
			}
		} catch (e) {
			if (turnAc.signal.aborted) return;
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
			const status: 'interrupted' | 'complete' = turnAc.signal.aborted ? 'interrupted' : 'complete';

			try {
				if (persistedAssistantId || assistantBuf || assistantId || pendingTools.size) {
					const id = ensurePersistedAssistant();
					messages.updateContent(id, assistantBuf, status);
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
				const assistantId = persistedAssistantId;
				// Surface tool-calling extractor activity as a subagent-style
				// card. The parent tool call is created lazily on the first
				// activity event, so extractors that don't call tools
				// (heuristic / single-shot JSON) never spawn an empty card.
				// Routing through `dispatch` persists the parent + threaded
				// children exactly like a real subagent, so the card survives
				// reloads and appears in history. Declared out here so the
				// catch below can close the card if extraction throws.
				let extractorParentId: string | null = null;
				let extractorAgentId: string | null = null;
				const ensureExtractorParent = (): string => {
					if (extractorParentId) return extractorParentId;
					extractorParentId = `mem_parent_${ulid()}`;
					extractorAgentId = `mem_agent_${ulid()}`;
					// Emit the same event shape as a real subagent: a `task` tool
					// call plus a `subagent.lifecycle` start. The `agent_type` arg
					// lets the UI label it without any extractor-specific casing
					// in the lower layers.
					dispatch({
						type: 'tool.call',
						toolCallId: extractorParentId,
						tool: 'task',
						args: {
							name: 'Memory extractor',
							description: 'Memory extraction',
							agent_type: 'memory-extractor'
						}
					});
					dispatch({
						type: 'subagent.lifecycle',
						toolCallId: extractorParentId,
						agentId: extractorAgentId,
						status: 'running'
					});
					return extractorParentId;
				};
				const closeExtractorParent = (status: 'completed' | 'failed') => {
					if (extractorParentId && extractorAgentId) {
						dispatch({
							type: 'subagent.lifecycle',
							toolCallId: extractorParentId,
							agentId: extractorAgentId,
							status
						});
					}
				};
				const onActivity = (activity: ExtractorActivity) => {
					const parentToolCallId = ensureExtractorParent();
					switch (activity.type) {
						case 'tool.call':
							dispatch({
								type: 'tool.call',
								toolCallId: activity.toolCallId,
								tool: activity.tool,
								args: activity.args,
								parentToolCallId
							});
							break;
						case 'tool.result':
							dispatch({
								type: 'tool.result',
								toolCallId: activity.toolCallId,
								ok: activity.ok,
								summary: activity.summary,
								output: activity.output,
								parentToolCallId
							});
							break;
						case 'reasoning':
							dispatch({
								type: 'message.reasoning',
								messageId: assistantId,
								segmentId: activity.segmentId,
								text: activity.text,
								parentToolCallId
							});
							break;
						case 'reasoning.end':
							dispatch({
								type: 'message.reasoning.end',
								messageId: assistantId,
								segmentId: activity.segmentId,
								durationMs: activity.durationMs,
								parentToolCallId
							});
							break;
						case 'content':
							dispatch({
								type: 'message.delta',
								messageId: assistantId,
								text: activity.text,
								parentToolCallId,
								segmentId: activity.segmentId
							});
							break;
					}
				};
				try {
					emit({
						type: 'memory.status',
						conversationId: opts.conversationId,
						phase: 'extracting',
						summary: 'Extracting durable memory updates.'
					});
					const userMessage = {
						id: opts.memory.userMessageId,
						conversationId: opts.conversationId,
						role: 'user',
						content: opts.memory.userContent,
						status: 'complete',
						errorCode: null,
						createdAt: Date.now()
					} as const;
					const assistantMessage = {
						id: persistedAssistantId,
						conversationId: opts.conversationId,
						role: 'assistant',
						content: assistantBuf,
						status: 'complete',
						errorCode: null,
						createdAt: Date.now()
					} as const;
					emit({
						type: 'memory.status',
						conversationId: opts.conversationId,
						phase: 'validating',
						summary: 'Validating durable memory patch.'
					});

					const committed = await extractAndCommitMemory({
						conversationId: opts.conversationId,
						userId: opts.bridge.userId,
						mode: opts.memory.mode,
						extractorModel: opts.memory.extractorModel,
						turnId: turn.id,
						userMessage,
						assistantMessage,
						onActivity
					});
					if (extractorParentId) {
						const spoken =
							committed.extraction.response?.trim() ||
							committed.patch.summary ||
							'Memory extraction complete.';
						dispatch({
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
						closeExtractorParent(
							committed.patch.status === 'needs_review' ? 'failed' : 'completed'
						);
						// Closed on the success path; null it so the catch below
						// doesn't double-close if a later statement throws.
						extractorParentId = null;
					}
					emit({
						type: 'memory.status',
						conversationId: opts.conversationId,
						phase: committed.patch.status === 'needs_review' ? 'needs_review' : 'committed',
						summary: committed.patch.summary || 'Memory patch processed.',
						patchId: committed.patch.id,
						counts: {
							events: committed.counts.events,
							facts: committed.counts.facts,
							decisions: committed.counts.decisions,
							openLoops: committed.counts.openLoops,
							issues: committed.counts.issues
						}
					});
				} catch (memoryErr) {
					if (extractorParentId) {
						dispatch({
							type: 'tool.result',
							toolCallId: extractorParentId,
							ok: false,
							summary: memoryFailureSummary(memoryErr),
							output: memoryFailureMessage(memoryErr)
						});
						closeExtractorParent('failed');
					}
					log.warn('turn.memory.failed', {
						conversationId: opts.conversationId,
						err: memoryFailureMessage(memoryErr),
						...memoryFailureLogFields(memoryErr)
					});
					emit({
						type: 'memory.status',
						conversationId: opts.conversationId,
						phase: 'needs_review',
						summary: memoryFailureSummary(memoryErr)
					});
				}
			}

			turn.status = status === 'interrupted' ? 'interrupted' : 'complete';
			turn.endedAt = Date.now();

			// Make sure subscribers see a terminal event even if the SDK
			// didn't emit `done` (e.g., on abort path).
			if (!eventLog.some((e) => e.type === 'done')) {
				emit({ type: 'done' });
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
	if (turn.status !== 'running') return;

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

function memoryFailureMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
