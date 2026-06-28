import { ulid } from 'ulid';
import { log } from '$lib/server/log';
import type { MemoryExtractorBackend } from '$lib/types';
import {
	commitPatch,
	extractHeuristicPatch,
	ageOpenLoops,
	buildInitialPacket,
	type CommitMemoryPatchInput,
	type MemoryPatchProposal
} from '../engine';
import { loadConfig } from '$lib/server/config';
import { redactSensitiveText, truncate } from './utils';
import {
	buildWriteToolSpecs,
	createWriteToolHandlers,
	buildStoredFactSignatures
} from './write-tools';
import { sanitizePatch } from './sanitize';
import { buildToolExtractorSystemPrompt, toolExtractorContextSections } from './prompts';
import { makeThinkStream, requestOpenAICompatibleChat } from './streaming';
import { OpenAICompatibleMemoryExtractor } from './single-shot';
import { buildMemoryTools } from '$lib/server/tools/memory';
import * as conversationsRepo from '$lib/server/db/repos/conversations';
import * as memoryRepo from '$lib/server/db/repos/memory';
import {
	type ExtractPatchInput,
	type ExtractPatchResult,
	type Diagnostic,
	type MemoryExtractor,
	type ExtractorChatMessage,
	type ExtractorToolSpec,
	type ExtractorStreamDelta,
	type ExtractorChatComplete
} from './types';
export type {
	ExtractorActivity,
	ExtractorActivityEmitter,
	ExtractPatchInput,
	ExtractPatchResult,
	MemoryExtractor,
	ExtractorChatMessage,
	ExtractorToolSpec,
	ExtractorAssistantTurn,
	ExtractorStreamDelta,
	ExtractorChatComplete
} from './types';
// Re-export the public transport surface so external importers (turn-runner,
// think-stream tests) keep importing from the barrel.
export { MemoryExtractorHttpError, makeThinkStream } from './streaming';
export { OpenAICompatibleMemoryExtractor } from './single-shot';

/**
 * Activity surfaced by a tool-calling extractor so callers (the turn runner)
 * can render the background agent's work like a normal subagent — a parent
 * card with each retrieval/staging call threaded underneath. Mirrors the
 * portal `tool.call` / `tool.result` event shapes so the runner can forward
 * them straight through its persistence path. The leading `input` event
 * carries the context handed to the extractor so the card can show its prompt.
 */
export class HeuristicMemoryExtractor implements MemoryExtractor {
	readonly kind = 'heuristic';

	async extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult> {
		const patch = extractHeuristicPatch({
			userMsg: input.userMessage,
			assistantContent: input.assistantMessage.content,
			mode: input.mode
		});
		return {
			patch,
			confidence: 0.45,
			summary: 'Heuristic memory extraction completed.',
			diagnostics: [
				{
					severity: 'info',
					code: 'heuristic_extractor',
					message:
						'Used local heuristic extraction. Configure a model-backed extractor to improve recall quality.'
				}
			]
		};
	}
}

interface ToolCallingExtractorOptions {
	baseUrl: string;
	apiKey?: string | null | undefined;
	model: string;
	timeoutMs: number;
	maxInputChars: number;
	maxToolIterations: number;
	/**
	 * Overall wall-clock budget for the whole tool-calling loop. `timeoutMs`
	 * bounds a single request; without this, `maxToolIterations` sequential
	 * requests could hold the turn open for minutes. Omitted in tests (no
	 * budget). Defaults to unbounded when unset.
	 */
	maxWallClockMs?: number | undefined;
	/**
	 * How many times `memory_end_extraction` may be blocked for unacknowledged
	 * write failures before the next attempt is force-accepted. Separate from the
	 * empty-turn nudge budget. Defaults to 2 when unset (tests can override).
	 */
	maxFailedCallNudges?: number | undefined;
	/** How the backend is told to pick tools ('auto' | 'required'). Default 'auto'. */
	toolChoice?: 'auto' | 'required' | undefined;
	/** Test seam: drive the tool-calling loop without a live backend. */
	chatComplete?: ExtractorChatComplete | undefined;
}

// Upper bound on a single tool result fed back to the extractor. Must comfortably
// exceed the staging tool's schema-rejection payload, which echoes the full
// `patch` JSON Schema so the agent can self-correct — that structured result is
// re-parsed as JSON, so truncating it mid-string would corrupt it.
const TOOL_RESULT_MAX_CHARS = 8_000;

// Upper bound on the assistant text we re-send each iteration. The model's own
// chain-of-thought is stripped before storing (see the loop), but even the
// visible text can be large with chatty local models, and it is resent on every
// subsequent request — so cap it to keep the growing transcript bounded.
const ASSISTANT_TRANSCRIPT_MAX_CHARS = 4_000;

// How many times an empty turn (a completion with no tool calls) is nudged
// toward an explicit finish before the loop gives up and stops on its own.
// Reasoning models frequently end a step with chain-of-thought but no tool
// call; rather than read that as "done" and stop (storing nothing), we re-prompt
// the model to either keep recording or call `memory_end_extraction`. Bounded so
// a model that never emits a tool call still terminates well before the iteration
// cap instead of burning the whole budget on empty rounds.
const MAX_EMPTY_TURN_NUDGES = 2;

// The corrective user message appended after an empty turn. Names the explicit
// finish tool so the model ends deliberately rather than by falling silent.
const EMPTY_TURN_NUDGE =
	'You did not call any tool. If there is anything durable left to record from this turn, call the appropriate write tool now. If you have recorded everything (or nothing durable needed storing), call memory_end_extraction to end the run — do not stop without calling it.';

// Name of the explicit finish control-tool. It is not a write (it stages
// nothing and is not advertised as a durable-write spec); the loop recognizes a
// call with this name as a clean end signal and reads its optional `summary`
// arg as the run summary.
const FINISH_EXTRACTION_TOOL = 'memory_end_extraction';

// How many times memory_end_extraction may be refused because the model has
// write failures it has neither fixed (via a threaded retry) nor acknowledged.
// Independent of MAX_EMPTY_TURN_NUDGES. Default used when the option is unset;
// the configured value (MEMORY_EXTRACTOR_MAX_FAILED_CALL_NUDGES) overrides it.
const DEFAULT_MAX_FAILED_CALL_NUDGES = 2;

// The tool-result error returned when memory_end_extraction is called while
// write failures are still outstanding. The error IS the nudge: it names the
// specific unacknowledged ids so the model can retry those writes (threading
// each id) or list them in `acknowledgedFailures` to end deliberately.
function buildUnackedFinishError(ids: string[]): string {
	return JSON.stringify({
		ok: false,
		tool: FINISH_EXTRACTION_TOOL,
		error: {
			kind: 'gate',
			code: 'unacknowledged_failures',
			message: `Cannot finish: ${ids.length} earlier write call(s) were rejected and never resolved.`
		},
		unacknowledgedFailures: ids,
		note: `Do NOT end the run yet. For each failure id [${ids.join(', ')}], either retry the write with the issues fixed (pass that id as \`failureId\` so it clears on success), or — if you are deliberately giving up on it — list it in memory_end_extraction's \`acknowledgedFailures\`. Every id must be cleared or acknowledged before the run can end.`
	});
}

// The explicit finish control-tool, advertised so its acknowledgment contract
// (the `acknowledgedFailures` array) is part of the schema the model sees. It
// stages nothing; the loop recognizes a call by this name as the end signal and
// reads its optional `summary`. `acknowledgedFailures` lets the model end the
// run while deliberately abandoning still-failing writes.
function buildFinishToolSpec(): ExtractorToolSpec {
	return {
		type: 'function',
		function: {
			name: FINISH_EXTRACTION_TOOL,
			description:
				'End the WHOLE extraction run — call this once, last, after you have staged every durable fact from this turn (or when nothing needed storing). This does NOT save a single memory; the individual write tools (memory_set_attributes, memory_add_directive, …) already staged those. Calling this is how you stop staging and exit the turn: it ends the loop and commits everything staged so far. Do NOT call it after each write — only when you are completely done. Provide an optional one-line `summary`. If any earlier write was rejected and you did not resolve it with a successful retry, you MUST list those `failureId`s in `acknowledgedFailures`, or the call is refused.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					summary: {
						type: 'string',
						maxLength: 1000,
						description: 'Optional one-line summary of what you recorded this turn.'
					},
					acknowledgedFailures: {
						type: 'array',
						items: { type: 'string', maxLength: 40 },
						description:
							'The `failureId` of every rejected write you are deliberately leaving unresolved. Required to finish while any failure is outstanding. A failure already cleared by a successful retry need not be listed.'
					}
				}
			}
		}
	};
}

/**
 * Agentic, tool-calling memory extractor. Instead of returning a single JSON
 * patch, a dedicated background agent stores durable memory by *calling tools*:
 * it retrieves with the read-only memory tools as needed and stages writes via
 * the per-kind `memory_*` / `memory_keep_loops` / `memory_close_loop` write tools, receiving
 * per-call validation feedback (e.g. "this fact is not attached to an entity but
 * must be") so it can self-correct with full turn context — context the
 * deterministic post-commit fixups never see.
 *
 * Staged proposals are merged and returned so the existing single durable
 * `commitPatch` (with extractor metadata, secret filtering, and entity-key
 * canonicalization as a backstop) still owns the authoritative write.
 */
export class ToolCallingMemoryExtractor implements MemoryExtractor {
	readonly kind = 'openai-compatible-tools';
	readonly model: string;
	private readonly opts: ToolCallingExtractorOptions;

	constructor(opts: ToolCallingExtractorOptions) {
		this.opts = opts;
		this.model = opts.model;
	}

	async extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult> {
		const staged: MemoryPatchProposal[] = [];
		const diagnostics: Diagnostic[] = [];
		let proposeCalls = 0;
		let rejectedProposals = 0;
		// Count of attribute items skipped because their value was already stored
		// unchanged (see write-tools redundancy check). Surfaced in logs and
		// diagnostics so the wasted-focus problem can be sized before/after the
		// prompt + feedback nudges that discourage re-asserting stored values.
		let redundantRewrites = 0;
		// Per-rejection reason tags for telemetry: keyed by `${tool}:${error.code}`
		// so logs show whether failures are schema (wrong-field-for-tool) vs
		// execution (e.g. unknown loop handle) — the data that tells us whether
		// the per-kind tool surface actually removed the structuring failures.
		const rejectionTags: Record<string, number> = {};

		const readTools = buildMemoryTools({
			userId: input.userId,
			conversationId: input.conversationId,
			// The extractor's retrieval calls are background work, not part of
			// the user-visible turn. Leave their tool-call records unattributed
			// so they don't mix into the foreground turn's memory_tool_calls
			// ledger (which would double-count when queried by turnId).
			getTurnId: () => null,
			mode: input.mode
		});

		const presentedLoops = input.initialPacket?.openLoops ?? [];

		const handlers = new Map<string, (args: unknown) => Promise<string>>();
		// Read tools now return the structured `ToolResult` envelope; the extractor
		// feeds tool results back to its model as plain message content, so
		// serialize the envelope here (mirroring the provider boundary).
		for (const tool of readTools)
			handlers.set(tool.name, async (args) => JSON.stringify(await tool.handler(args)));
		// Read-tool results are durable memory content fed verbatim to the
		// (possibly external/less-trusted) extractor model. Write-time secret
		// filtering can miss obfuscated or model-summarized values, so re-screen
		// these results before they enter the transcript (see the push site below).
		const readToolNames = new Set(readTools.map((tool) => tool.name));
		const writeHandlers = createWriteToolHandlers({
			conversationId: input.conversationId,
			mode: input.mode,
			presentedLoops,
			storedFactSignatures: buildStoredFactSignatures(input.initialPacket),
			staged,
			onProposeCall: () => {
				proposeCalls += 1;
			},
			onReject: () => {
				rejectedProposals += 1;
			},
			onRedundant: () => {
				redundantRewrites += 1;
			}
		});
		for (const [name, fn] of writeHandlers) handlers.set(name, fn);

		const toolSpecs: ExtractorToolSpec[] = [
			...readTools.map((tool) => ({
				type: 'function' as const,
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters
				}
			})),
			...buildWriteToolSpecs(),
			buildFinishToolSpec()
		];

		const userContent = truncate(
			toolExtractorContextSections(input).join('\n\n'),
			this.opts.maxInputChars
		);
		// Surface the context handed to the background extractor as the
		// subagent's "input" so the card can show what it was asked to work
		// from, mirroring the prompt shown for a real subagent. Emitted before
		// any model output so the parent card is created carrying its prompt.
		input.onActivity?.({ type: 'input', text: userContent });
		const messages: ExtractorChatMessage[] = [
			{ role: 'system', content: buildToolExtractorSystemPrompt() },
			{
				role: 'user',
				content: userContent
			}
		];

		const chat = this.opts.chatComplete ?? requestOpenAICompatibleChat.bind(null, this.opts);
		let finalContent = '';
		let voluntaryStop = false;
		let hitWallClockBudget = false;
		let iterationsRun = 0;
		let totalToolCalls = 0;
		let emptyTurnNudges = 0;
		// Write failures the model has not yet resolved (cleared via a threaded
		// retry) or acknowledged at finish. Fully model-driven: ids are added when
		// a write returns ok:false carrying a `failureId`, removed when a success
		// echoes `clearedFailureId`, and subtracted by `acknowledgedFailures` at
		// memory_end_extraction. A clean end requires this to be empty.
		const outstandingFailures = new Set<string>();
		// How many times memory_end_extraction has been refused for outstanding
		// failures. Once it reaches the budget, the next call is force-accepted
		// (staged work commits, a diagnostic records the still-unacked ids).
		let failedCallNudges = 0;
		const maxFailedCallNudges = this.opts.maxFailedCallNudges ?? DEFAULT_MAX_FAILED_CALL_NUDGES;
		const deadline = Date.now() + (this.opts.maxWallClockMs ?? Number.POSITIVE_INFINITY);
		for (let iteration = 0; iteration < this.opts.maxToolIterations; iteration += 1) {
			// A user "stop" during background extraction aborts the turn's
			// signal; bail before starting another model round-trip.
			input.signal?.throwIfAborted();
			// Bound the whole loop, not just each request: maxToolIterations
			// sequential calls (each up to timeoutMs) could otherwise hold the
			// turn open for minutes. Stop before starting another step once the
			// budget is spent.
			if (Date.now() >= deadline) {
				hitWallClockBudget = true;
				break;
			}
			iterationsRun += 1;
			const stepStartedAt = Date.now();

			// Stream the model's output live, exactly like a real (now
			// fully-featured) subagent: provider reasoning tokens and inline
			// <think>…</think> stream as threaded *reasoning*, while spoken
			// (non-think) content streams as threaded *content* — so the nested
			// session renders its response interleaved with its thoughts and
			// tools. Both segments are created lazily on first token.
			let thinkSegmentId: string | null = null;
			let contentSegmentId: string | null = null;
			const thinkStream = makeThinkStream();
			const emitThought = (text: string) => {
				if (!text) return;
				if (!thinkSegmentId) thinkSegmentId = `mem_think_${ulid()}`;
				input.onActivity?.({ type: 'reasoning', segmentId: thinkSegmentId, text });
			};
			const emitContent = (text: string) => {
				if (!text) return;
				if (!contentSegmentId) contentSegmentId = `mem_say_${ulid()}`;
				input.onActivity?.({ type: 'content', segmentId: contentSegmentId, text });
			};
			const onDelta = (delta: ExtractorStreamDelta) => {
				if (delta.reasoning) emitThought(delta.reasoning);
				if (delta.content) {
					const { think, visible } = thinkStream.push(delta.content);
					emitThought(think);
					emitContent(visible);
				}
			};

			// `tool_choice: 'required'` forces a tool call on every completion,
			// but the loop only terminates on a tool-call-free turn (see below).
			// Applying 'required' beyond the first step would make voluntary
			// termination impossible — the model could never stop, always running
			// to the iteration/wall-clock cap and being forced into spurious
			// writes once nothing durable remains. So force only the FIRST step
			// (to push ramble-prone models into acting), then relax to 'auto' so
			// the model can stop by emitting no tool calls.
			const stepToolChoice: 'auto' | 'required' =
				this.opts.toolChoice === 'required' && iteration === 0 ? 'required' : 'auto';
			const turn = await chat(messages, toolSpecs, onDelta, input.signal, stepToolChoice);
			{
				const { think, visible } = thinkStream.flush();
				emitThought(think);
				emitContent(visible);
			}
			totalToolCalls += turn.toolCalls.length;
			const hasMoreToolCalls = turn.toolCalls.length > 0;
			const { visible, think } = splitThink(turn.content || '');
			// Fallback for non-streaming chat implementations (e.g. injected
			// test doubles) that never called `onDelta`: synthesize the thought
			// and content blocks from the final turn so behavior matches the
			// streaming path.
			if (!thinkSegmentId && !contentSegmentId) {
				const thoughts = [turn.reasoning?.trim(), think.trim()].filter(Boolean).join('\n\n');
				emitThought(thoughts);
				emitContent(visible.trim());
			}
			if (thinkSegmentId) {
				input.onActivity?.({
					type: 'reasoning.end',
					segmentId: thinkSegmentId,
					durationMs: Math.max(0, Date.now() - stepStartedAt)
				});
			}
			// The explicit finish signal: a control-tool call, not a write. When
			// accepted it ends the run (below) and its optional `summary` seeds the
			// run summary; a finish refused by the failure gate is re-prompted
			// instead. It also counts as "this turn spoke a final word", so the
			// turn's visible text can still serve as the summary when no explicit
			// `summary` arg is given.
			const finishCall = turn.toolCalls.find((call) => call.name === FINISH_EXTRACTION_TOOL);
			if ((!hasMoreToolCalls || finishCall) && visible.trim()) finalContent = visible.trim();
			if (finishCall) {
				const finishSummary = parseFinishSummary(finishCall.arguments);
				if (finishSummary) finalContent = finishSummary;
			}
			messages.push({
				role: 'assistant',
				// Re-send only the bounded, think-stripped assistant text: the
				// model doesn't need its own chain-of-thought back, and unbounded
				// <think> blocks accumulated across iterations would balloon every
				// subsequent request. A tool-call-free turn must carry a string
				// (never null) so the corrective nudge appended after it forms a
				// valid assistant→user exchange for providers that reject a
				// null-content assistant message without tool calls.
				content:
					truncate(visible, ASSISTANT_TRANSCRIPT_MAX_CHARS) || (hasMoreToolCalls ? null : ''),
				...(turn.toolCalls.length > 0
					? {
							tool_calls: turn.toolCalls.map((call) => ({
								id: call.id,
								type: 'function' as const,
								function: { name: call.name, arguments: call.arguments }
							}))
						}
					: {})
			});
			if (turn.toolCalls.length === 0) {
				// An empty turn is no longer a stop. Reasoning models routinely end
				// a step with chain-of-thought and no tool call; treating that as
				// "done" is exactly what stored nothing. Nudge the model toward an
				// explicit finish (or further writes), bounded so a model that never
				// emits a tool call still terminates rather than running to the cap.
				if (emptyTurnNudges < MAX_EMPTY_TURN_NUDGES) {
					emptyTurnNudges += 1;
					messages.push({ role: 'user', content: EMPTY_TURN_NUDGE });
					continue;
				}
				voluntaryStop = true;
				break;
			}
			// The model acted this turn; renew the empty-turn nudge budget so a
			// later, separate stall is still given its full allowance.
			emptyTurnNudges = 0;
			// Whether this turn's finish call was accepted (clean or force-finish).
			// Set inside the loop so a finish refused by the failure gate does NOT
			// end the run — the loop continues so the model can resolve or
			// acknowledge the outstanding failures.
			let finishAccepted = false;
			for (const call of turn.toolCalls) {
				input.signal?.throwIfAborted();
				// memory_end_extraction is a control signal, not a write: it stages
				// nothing and is never dispatched to a write handler. We still
				// surface it as a tool card so the run visibly ends on an explicit
				// model decision rather than appearing to stop on its own. The run
				// is ended after this turn's real tool calls are processed (so
				// writes batched alongside the end call still commit).
				if (call.name === FINISH_EXTRACTION_TOOL) {
					// Acknowledging an id clears it from the outstanding set even if
					// the model never retried the write — an explicit "I'm dropping
					// this" decision (acknowledge-ALL semantics).
					for (const id of parseAcknowledgedFailures(call.arguments))
						outstandingFailures.delete(id);
					const remaining = [...outstandingFailures];
					const finishActivityId = `mem_${ulid()}`;
					input.onActivity?.({
						type: 'tool.call',
						toolCallId: finishActivityId,
						tool: call.name,
						args: parseActivityArgs(call.arguments)
					});
					// Finish gate: refuse to end cleanly while failures are neither
					// cleared nor acknowledged, but only while the dedicated budget
					// remains. The refusal's error IS the corrective nudge.
					if (remaining.length > 0 && failedCallNudges < maxFailedCallNudges) {
						failedCallNudges += 1;
						const errorPayload = buildUnackedFinishError(remaining);
						input.onActivity?.({
							type: 'tool.result',
							toolCallId: finishActivityId,
							ok: false,
							summary: `finish blocked — ${remaining.length} unacknowledged write failure(s)`,
							output: errorPayload
						});
						// The assistant message already carried this finish tool_call,
						// so a tool result for it must be fed back before the next
						// request, and it doubles as the nudge.
						messages.push({
							role: 'tool',
							tool_call_id: call.id,
							content: truncate(errorPayload, TOOL_RESULT_MAX_CHARS)
						});
						continue;
					}
					// Accepted — either cleanly (no outstanding failures) or as a
					// force-finish once the budget is spent. Force-finish salvages
					// the run: staged work still commits; the still-unacknowledged
					// ids are surfaced as a diagnostic after the loop.
					const finishSummary = parseFinishSummary(call.arguments);
					input.onActivity?.({
						type: 'tool.result',
						toolCallId: finishActivityId,
						ok: true,
						summary: finishSummary
							? `extraction finished — ${finishSummary}`
							: 'extraction finished',
						output: (call.arguments ?? '').trim() || '{}'
					});
					finishAccepted = true;
					continue;
				}
				const activityId = `mem_${ulid()}`;
				input.onActivity?.({
					type: 'tool.call',
					toolCallId: activityId,
					tool: call.name || '(missing tool name)',
					args: parseActivityArgs(call.arguments)
				});
				const result = await dispatchExtractorToolCall(handlers, call);
				if (!activityResultOk(result)) {
					// Tag rejections by tool + error code for telemetry, and track the
					// stable failureId so the finish gate can require it be resolved.
					try {
						const parsed = JSON.parse(result) as {
							tool?: string;
							error?: { code?: string };
							failureId?: unknown;
						};
						const tag = `${parsed.tool ?? call.name}:${parsed.error?.code ?? 'unknown'}`;
						rejectionTags[tag] = (rejectionTags[tag] ?? 0) + 1;
						if (typeof parsed.failureId === 'string' && parsed.failureId) {
							// Cap the model-supplied id to bound the in-memory Set,
							// mirroring the `acknowledgedFailures` schema (maxLength: 40).
							if (parsed.failureId.length <= 40) {
								outstandingFailures.add(parsed.failureId);
							} else {
								log.warn('memory.extractor.failure_id_too_long', {
									length: parsed.failureId.length
								});
							}
						}
					} catch {
						// Non-JSON failure (e.g. thrown exception); ignore for tagging.
					}
				} else {
					// A successful threaded retry clears the failure it resolved.
					try {
						const parsed = JSON.parse(result) as { clearedFailureId?: unknown };
						if (typeof parsed.clearedFailureId === 'string' && parsed.clearedFailureId)
							outstandingFailures.delete(parsed.clearedFailureId);
					} catch {
						// Non-JSON success; nothing to clear.
					}
				}
				input.onActivity?.({
					type: 'tool.result',
					toolCallId: activityId,
					ok: activityResultOk(result),
					summary: activityResultSummary(call.name, result),
					output: result
				});
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					// Read-tool output is durable memory that may carry secrets the
					// write-time filter missed (zero-width-obfuscated tokens,
					// JSON-escaped values, model-generated summaries), so re-redact
					// it before it reaches the (possibly external) extractor model —
					// closing an exfiltration channel. Write-tool output only echoes
					// the model's own staged input, so it's passed through; thrown-
					// exception messages are redacted at the dispatch boundary
					// (dispatchExtractorToolCall).
					content: truncate(
						readToolNames.has(call.name) ? redactSensitiveText(result) : result,
						TOOL_RESULT_MAX_CHARS
					)
				});
			}
			// The model explicitly ended the run this turn (after any writes it
			// batched alongside the finish call were processed above). A finish
			// refused by the failure gate did not set this, so the loop continues.
			if (finishAccepted) {
				voluntaryStop = true;
				break;
			}
		}

		const merged = mergePatchProposals(staged, input.conversationId);
		const sanitized = sanitizePatch(merged, input.initialPacket);
		// The loop ran to the iteration cap only if the model neither stopped on
		// its own nor ran out of wall-clock budget.
		const hitIterationCap = !voluntaryStop && !hitWallClockBudget;
		// Definitive signal for "tool extractor selected but no card appeared":
		// totalToolCalls === 0 means the model never emitted a tool call (common
		// with weak local models), so there was no activity to render.
		log.info('memory.extractor.tool_run', {
			conversationId: input.conversationId,
			model: this.model,
			iterations: iterationsRun,
			totalToolCalls,
			proposeCalls,
			rejectedProposals,
			rejectionTags,
			redundantRewrites,
			stagedProposals: staged.length,
			hitIterationCap,
			hitWallClockBudget,
			failedCallNudges,
			unacknowledgedFailures: outstandingFailures.size
		});
		diagnostics.push(...sanitized.diagnostics);
		diagnostics.push({
			severity: 'info',
			code: 'tool_calling_extractor',
			message: `Tool-calling extractor ran ${proposeCalls} durable-write tool call(s) across the turn.`
		});
		if (proposeCalls === 0) {
			diagnostics.push({
				severity: 'info',
				code: 'no_proposals_staged',
				message: 'The tool-calling extractor stored nothing durable for this turn.'
			});
		}
		if (rejectedProposals > 0) {
			diagnostics.push({
				severity: 'warning',
				code: 'proposals_with_issues',
				message: `${rejectedProposals} staged proposal(s) reported validation issues during extraction.`
			});
		}
		if (redundantRewrites > 0) {
			diagnostics.push({
				severity: 'info',
				code: 'redundant_rewrite',
				message: `${redundantRewrites} attribute(s) were already stored unchanged and were skipped rather than re-recorded.`
			});
		}
		if (hitWallClockBudget) {
			diagnostics.push({
				severity: 'warning',
				code: 'tool_budget_exhausted',
				message: `Extractor stopped after exhausting its ${this.opts.maxWallClockMs}ms wall-clock budget.`
			});
		} else if (hitIterationCap) {
			diagnostics.push({
				severity: 'warning',
				code: 'tool_iteration_cap',
				message: `Extractor stopped after reaching the ${this.opts.maxToolIterations}-iteration tool cap.`
			});
		}
		// Any write failure the model never cleared (via a threaded retry) nor
		// acknowledged at finish is surfaced here so the drop is observable rather
		// than silent. Covers the force-finish path (budget spent) as well as a
		// silent stall, the empty-turn-nudge exhaustion, and the caps above.
		if (outstandingFailures.size > 0) {
			diagnostics.push({
				severity: 'warning',
				code: 'unacknowledged_write_failures',
				message: `Extraction ended with ${outstandingFailures.size} unresolved write failure(s) the model never fixed or acknowledged: ${[...outstandingFailures].join(', ')}.`
			});
		}

		const summary = finalContent.trim() || 'Tool-calling memory extraction completed.';

		return {
			patch: sanitized.patch,
			confidence: proposeCalls > 0 ? 0.8 : 0,
			summary: summary.slice(0, 1000),
			diagnostics,
			rawModelOutput: messages,
			response: finalContent.trim() || undefined
		};
	}
}

async function dispatchExtractorToolCall(
	handlers: Map<string, (args: unknown) => Promise<string>>,
	call: { name: string; arguments: string }
): Promise<string> {
	const handler = handlers.get(call.name);
	if (!handler) {
		// Surface the exact callable names so a model that invented or mangled a
		// tool name (e.g. dropping the verb to produce `memory_entity`) can
		// self-correct on its next turn instead of hitting a dead end.
		return JSON.stringify({
			error: `Unknown tool: ${call.name || '(missing name)'}`,
			hint: 'Call one of the valid tools, named exactly as listed.',
			validTools: [...handlers.keys(), FINISH_EXTRACTION_TOOL].sort()
		});
	}
	let args: unknown = {};
	const trimmed = (call.arguments ?? '').trim();
	if (trimmed) {
		try {
			args = JSON.parse(trimmed);
		} catch (e) {
			return JSON.stringify({
				error: `Invalid JSON arguments: ${e instanceof Error ? e.message : String(e)}`
			});
		}
	}
	try {
		return await handler(args);
	} catch (e) {
		return JSON.stringify({
			error: redactSensitiveText(e instanceof Error ? e.message : String(e))
		});
	}
}

function parseActivityArgs(raw: string): unknown {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		return { _raw: trimmed };
	}
}

/**
 * Pull the optional one-line `summary` out of a `memory_end_extraction` call's
 * arguments. Tolerant of the malformed/partial JSON small models emit: returns
 * null when there is no usable string summary, so the caller falls back to the
 * turn's visible text.
 */
function parseFinishSummary(raw: string): string | null {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as { summary?: unknown };
		return typeof parsed.summary === 'string' && parsed.summary.trim()
			? parsed.summary.trim()
			: null;
	} catch {
		return null;
	}
}

/**
 * Pull the `acknowledgedFailures` id list out of a `memory_end_extraction`
 * call's arguments. Tolerant of malformed/partial JSON (small models): returns
 * an empty array when there is no usable string array, so a missing/garbled ack
 * simply leaves outstanding failures unacknowledged (the finish gate then
 * applies). Non-string and blank entries are dropped.
 */
function parseAcknowledgedFailures(raw: string): string[] {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed) as { acknowledgedFailures?: unknown };
		if (!Array.isArray(parsed.acknowledgedFailures)) return [];
		return parsed.acknowledgedFailures
			.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
			.map((id) => id.trim());
	} catch {
		return [];
	}
}

/**
 * Split inline chain-of-thought (<think>…</think> / <thinking>…</thinking>,
 * as emitted by many local reasoning models) out of the spoken content.
 * Returns the visible text with think blocks removed and the concatenated
 * think text.
 */
function splitThink(content: string): { visible: string; think: string } {
	const thinks: string[] = [];
	const visible = content
		.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_match, inner: string) => {
			thinks.push(inner.trim());
			return '';
		})
		.trim();
	return { visible, think: thinks.filter(Boolean).join('\n\n') };
}

/**
 * Whether a tool result represents success. The write tools return an explicit
 * `ok` boolean, which is authoritative: a rejected/failed write (ok:false) must
 * render as not-successful even though it carries no `error` *string* — a
 * validation rejection is a structured `error` object, not a thrown exception.
 * Read-tool results without `ok` fall back to "successful unless it carries a
 * string `error`".
 */
function activityResultOk(result: string): boolean {
	try {
		const parsed = JSON.parse(result);
		if (parsed && typeof parsed === 'object') {
			if (typeof (parsed as { ok?: unknown }).ok === 'boolean') {
				return (parsed as { ok: boolean }).ok;
			}
			if (typeof (parsed as { error?: unknown }).error === 'string') {
				return false;
			}
		}
	} catch {
		// Non-JSON output is still a successful execution.
	}
	return true;
}

function activityResultSummary(toolName: string, result: string): string {
	try {
		const parsed = JSON.parse(result) as Record<string, unknown>;
		// New write-tool envelope: ok + action/error + staged_totals.
		if (typeof parsed.ok === 'boolean') {
			if (parsed.ok === false) {
				const err = (parsed.error ?? {}) as { message?: unknown };
				const count = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
				const detail = typeof err.message === 'string' ? err.message : `${count} issue(s)`;
				return `not staged — ${detail}`;
			}
			const action = typeof parsed.action === 'string' ? parsed.action : 'staged';
			const totals = (parsed.staged_totals ?? {}) as Record<string, number>;
			const total = Object.values(totals).reduce((sum, n) => sum + (Number(n) || 0), 0);
			const warnings = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
			return `${action} — ${total} staged${warnings > 0 ? `, ${warnings} warning(s)` : ''}`;
		}
		if (typeof parsed.error === 'string') return `${toolName}: ${parsed.error}`;
		if (Array.isArray(parsed.results)) return `${parsed.results.length} result(s)`;
	} catch {
		// fall through to generic summary
	}
	const singleLine = result.replace(/\s+/g, ' ').trim();
	return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine || '(no output)';
}

function mergePatchProposals(
	patches: MemoryPatchProposal[],
	conversationId?: string
): MemoryPatchProposal {
	const merged: MemoryPatchProposal = {};
	const entities = patches.flatMap((patch) => patch.entities ?? []);
	const events = patches.flatMap((patch) => patch.events ?? []);
	const facts = patches.flatMap((patch) => patch.facts ?? []);
	const openLoops = patches.flatMap((patch) => patch.openLoops ?? []);
	// De-dupe resolutions by canonical loop id (last write wins) so a loop the
	// model staged twice across calls is only resolved once. The model may
	// reference the same loop by both its stable loop_key and its raw ULID;
	// resolve each to the canonical id (mirroring validatePatch) so both forms
	// collapse to one entry instead of emitting an open_loop_resolution_duplicate.
	const resolutionById = new Map<
		string,
		NonNullable<MemoryPatchProposal['resolveOpenLoops']>[number]
	>();
	for (const patch of patches) {
		for (const resolution of patch.resolveOpenLoops ?? []) {
			const loopId = conversationId
				? memoryRepo.resolveOpenLoopId(conversationId, resolution.id)
				: null;
			const dedupeKey = loopId ?? resolution.id;
			resolutionById.set(dedupeKey, resolution);
		}
	}
	// Union the "keep alive" set across every staged proposal. A loop reaffirmed
	// in ANY call counts as touched — the agent may spread keeps across several
	// memory_keep_loops calls, and liveness decay runs once on this collapsed
	// patch, so a keep dropped here would let a still-live loop age out.
	const keepOpenLoops = [...new Set(patches.flatMap((patch) => patch.keepOpenLoops ?? []))];
	// De-dupe forget targets by their selector (handle, or entityKey+predicate)
	// so the same fact staged for forgetting across calls is tombstoned once.
	const forgetByKey = new Map<string, NonNullable<MemoryPatchProposal['forgetFacts']>[number]>();
	for (const patch of patches) {
		for (const target of patch.forgetFacts ?? []) {
			const key = target.factId
				? `id:${target.factId}`
				: `kp:${target.entityKey ?? ''}|${target.predicate ?? ''}`;
			forgetByKey.set(key, target);
		}
	}
	if (entities.length > 0) merged.entities = entities;
	if (events.length > 0) merged.events = events;
	if (facts.length > 0) merged.facts = facts;
	if (openLoops.length > 0) merged.openLoops = openLoops;
	if (resolutionById.size > 0) merged.resolveOpenLoops = [...resolutionById.values()];
	if (keepOpenLoops.length > 0) merged.keepOpenLoops = keepOpenLoops;
	if (forgetByKey.size > 0) merged.forgetFacts = [...forgetByKey.values()];
	return merged;
}

/**
 * Selects the configured memory extractor for a turn. Returns a model-backed
 * extractor (tool-calling or single-shot) when the backend and its
 * prerequisites are configured, otherwise falls back to the heuristic
 * extractor (logging why, so misconfiguration is diagnosable).
 */
export function createMemoryExtractor(
	opts: {
		model?: string | null | undefined;
		backend?: MemoryExtractorBackend | null | undefined;
	} = {}
): MemoryExtractor {
	const cfg = loadConfig();
	// Precedence: per-conversation backend override → server default env backend.
	const backend = opts.backend ?? cfg.MEMORY_EXTRACTOR_BACKEND;
	const wantsModel = backend === 'openai-compatible' || backend === 'openai-compatible-tools';
	if (wantsModel) {
		const model = opts.model?.trim() || cfg.MEMORY_EXTRACTOR_MODEL;
		if (cfg.OPENAI_COMPATIBLE_BASE_URL && model) {
			if (backend === 'openai-compatible-tools') {
				return new ToolCallingMemoryExtractor({
					baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
					apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
					model,
					timeoutMs: cfg.MEMORY_EXTRACTOR_TIMEOUT_MS,
					maxInputChars: cfg.MEMORY_EXTRACTOR_MAX_INPUT_CHARS,
					maxToolIterations: cfg.MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS,
					maxWallClockMs: cfg.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS,
					maxFailedCallNudges: cfg.MEMORY_EXTRACTOR_MAX_FAILED_CALL_NUDGES,
					toolChoice: cfg.MEMORY_EXTRACTOR_TOOL_CHOICE
				});
			}
			return new OpenAICompatibleMemoryExtractor({
				baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
				apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
				model,
				timeoutMs: cfg.MEMORY_EXTRACTOR_TIMEOUT_MS,
				maxInputChars: cfg.MEMORY_EXTRACTOR_MAX_INPUT_CHARS
			});
		}
		// A model-backed backend was requested but the prerequisites are
		// missing, so we silently fall back to heuristic — historically a
		// confusing "extraction runs but nothing model-driven happens"
		// failure. Surface it so misconfiguration is diagnosable.
		log.warn('memory.extractor.fallback_heuristic', {
			backend,
			hasBaseUrl: Boolean(cfg.OPENAI_COMPATIBLE_BASE_URL),
			hasModel: Boolean(model),
			reason: !cfg.OPENAI_COMPATIBLE_BASE_URL
				? 'OPENAI_COMPATIBLE_BASE_URL is not set'
				: 'no extractor model configured (set MEMORY_EXTRACTOR_MODEL or a per-conversation extractor model)'
		});
	}
	return new HeuristicMemoryExtractor();
}

/**
 * Returns true when a model-backed extractor is configured for the given
 * options. When this is true the extractor — not the main model — owns writing
 * durable memory for each turn; the main model has no direct memory write tool.
 */
export function isModelBackedExtractorConfigured(
	opts: {
		model?: string | null | undefined;
		backend?: MemoryExtractorBackend | null | undefined;
	} = {}
): boolean {
	return createMemoryExtractor(opts).kind !== 'heuristic';
}

/**
 * Acquire the per-conversation extraction lock, polling until it is free, the
 * timeout elapses, or the turn aborts. Returns whether the lock is now held;
 * callers that fail to acquire still proceed (the commitPatch dedupe is the
 * authoritative backstop) but lose the serialization benefit, so a false return
 * is logged rather than fatal.
 */
async function acquireExtractionLock(
	conversationId: string,
	holder: string,
	opts: {
		ttlMs: number;
		timeoutMs: number;
		pollMs?: number | undefined;
		signal?: AbortSignal | undefined;
	}
): Promise<boolean> {
	const pollMs = opts.pollMs ?? 100;
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		if (memoryRepo.tryAcquireExtractionLock(conversationId, holder, { ttlMs: opts.ttlMs })) {
			return true;
		}
		if (opts.signal?.aborted) return false;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

export async function extractAndCommitMemory(
	input: ExtractPatchInput
): Promise<
	ReturnType<typeof commitPatch> & { extraction: ExtractPatchResult; extractorKind: string }
> {
	const extractor = createMemoryExtractor({
		model: input.extractorModel,
		backend: input.extractorBackend
	});
	// Always record which extractor actually ran. This is the definitive
	// signal when diagnosing "extraction happens but no subagent card": only
	// the `openai-compatible-tools` kind emits tool activity / a card.
	log.info('memory.extractor.selected', {
		conversationId: input.conversationId,
		kind: extractor.kind,
		model: extractor.model ?? null,
		emitsActivity: extractor.kind === 'openai-compatible-tools'
	});
	// Serialize extractions for one conversation. Two simultaneous passes (rapid
	// sends, or a retry firing while the background extractor still runs) would
	// otherwise each snapshot the same pre-commit state below and both commit —
	// appending duplicate events/open loops. Hold the lock across the whole
	// snapshot -> commit window. The TTL outlives the extractor's wall-clock +
	// watchdog budget so a crashed holder is reaped rather than wedging the
	// conversation; acquisition waits up to the same budget for an in-flight pass
	// to finish. Failing to acquire is non-fatal (commitPatch dedupe backstops).
	const cfg = loadConfig();
	const lockTtlMs =
		cfg.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS + cfg.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS + 30_000;
	const lockHolder = ulid();
	const lockHeld = await acquireExtractionLock(input.conversationId, lockHolder, {
		ttlMs: lockTtlMs,
		timeoutMs: lockTtlMs,
		signal: input.signal
	});
	if (!lockHeld) {
		log.warn('memory.extractor.lock_unavailable', {
			conversationId: input.conversationId,
			turnId: input.turnId ?? null
		});
	}
	try {
		return await runExtractionAndCommit(input, extractor);
	} finally {
		if (lockHeld) memoryRepo.releaseExtractionLock(input.conversationId, lockHolder);
	}
}

async function runExtractionAndCommit(
	input: ExtractPatchInput,
	extractor: MemoryExtractor
): Promise<
	ReturnType<typeof commitPatch> & { extraction: ExtractPatchResult; extractorKind: string }
> {
	// extractor must see the existing durable state — crucially the open-loop
	// ids — to reuse keys and to keep/close loops by id. Callers (tests) may
	// supply their own packet; production does not, so build one here keyed on
	// the user message. Without this the single-shot extractor renders
	// "Initial packet: (none)" and is blind to existing ids.
	if (!input.initialPacket) {
		const globalMemoryEnabled =
			conversationsRepo.get(input.conversationId, input.userId)?.globalMemoryEnabled ?? false;
		const build = () =>
			buildInitialPacket(input.conversationId, input.mode, {
				query: input.userMessage.content,
				globalMemoryEnabled
			});
		// Retry path: a prior committed patch from THIS turn is already in durable
		// memory. Building the packet against the live state would show the
		// re-extractor its own prior output as already-recorded, so it would skip
		// re-recording it. `readMemoryAtTurnStart` instead presents memory as of
		// the turn's start (rolled back immediately, no durable writes) — see its
		// docstring for the mechanism and failure-safety rationale.
		input.initialPacket = input.priorPatchId
			? memoryRepo.readMemoryAtTurnStart(input.conversationId, input.assistantMessage.id, build)
			: build();
	}
	const presentedLoopIds = input.initialPacket.openLoops.map((loop) => loop.id);

	const extraction = await extractor.extractPatch(input);
	// A user Stop (or the turn-runner watchdog) aborts the extraction signal.
	// If the extractor ignored the signal and still returned, refuse to commit:
	// the turn is being torn down and a late partial patch must not land.
	input.signal?.throwIfAborted();
	const commitInput: CommitMemoryPatchInput = {
		conversationId: input.conversationId,
		mode: input.mode,
		turnId: input.turnId,
		sourceMessageId: input.assistantMessage.id,
		patch: extraction.patch,
		summary: extraction.summary,
		// Defer the prior-patch undo (retry path) into `commitPatch`, which runs
		// it only when the replacement patch validates and is about to be applied.
		// A `needs_review`, failed, or aborted extraction therefore never destroys
		// the existing committed memory.
		beforeCommit: input.beforeCommit
	};
	const committed = commitPatch(commitInput, {
		extractorKind: extractor.kind,
		extractorModel: extractor.model,
		extractorConfidence: extraction.confidence,
		extractorDiagnostics: extraction.diagnostics
	});

	// Open-loop liveness: age out loops the extractor was shown but neither kept
	// nor closed. Gated to model-backed extractors (the heuristic extractor never
	// populates keepOpenLoops, so letting it age would drop everything) and to a
	// cleanly committed pass (a needs_review patch is not a reliable liveness
	// signal). Runs after commit so loops closed this turn are already out of the
	// open set.
	const baseThreshold = loadConfig().MEMORY_OPEN_LOOP_MAX_IDLE_TURNS;
	if (
		extractor.kind !== 'heuristic' &&
		committed.patch.status === 'committed' &&
		baseThreshold > 0
	) {
		// keepOpenLoops/closeLoops may reference loops by their stable key or raw
		// id; liveness compares against presentedLoopIds (canonical ids), so
		// resolve every reference to its id and drop any that don't resolve.
		const keptLoopIds = [
			...(extraction.patch.keepOpenLoops ?? []),
			...(extraction.patch.resolveOpenLoops ?? []).map((resolution) => resolution.id)
		]
			.map((ref) => memoryRepo.resolveOpenLoopId(input.conversationId, ref))
			.filter((id): id is string => !!id);
		const aged = ageOpenLoops(input.conversationId, {
			presentedLoopIds,
			keptLoopIds,
			baseThreshold,
			sourceMessageId: input.assistantMessage.id,
			turnId: input.turnId
		});
		if (aged.dropped.length) {
			log.info('memory.open_loops.auto_dropped', {
				conversationId: input.conversationId,
				count: aged.dropped.length,
				baseThreshold
			});
		}
	}
	return { ...committed, extraction, extractorKind: extractor.kind };
}
