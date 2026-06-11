import { ulid } from 'ulid';
import { log } from '$lib/server/log';
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
	apiKey?: string | null;
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
	maxWallClockMs?: number;
	/** How the backend is told to pick tools ('auto' | 'required'). Default 'auto'. */
	toolChoice?: 'auto' | 'required';
	/** Test seam: drive the tool-calling loop without a live backend. */
	chatComplete?: ExtractorChatComplete;
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

/**
 * Agentic, tool-calling memory extractor. Instead of returning a single JSON
 * patch, a dedicated background agent stores durable memory by *calling tools*:
 * it retrieves with the read-only memory tools as needed and stages writes via
 * the per-kind `remember_*` / `keep_loops` / `close_loop` write tools, receiving
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
			...buildWriteToolSpecs()
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
			if (!hasMoreToolCalls && visible.trim()) finalContent = visible.trim();
			messages.push({
				role: 'assistant',
				// Re-send only the bounded, think-stripped assistant text: the
				// model doesn't need its own chain-of-thought back, and unbounded
				// <think> blocks accumulated across iterations would balloon every
				// subsequent request.
				content: truncate(visible, ASSISTANT_TRANSCRIPT_MAX_CHARS) || null,
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
				voluntaryStop = true;
				break;
			}
			for (const call of turn.toolCalls) {
				input.signal?.throwIfAborted();
				const activityId = `mem_${ulid()}`;
				input.onActivity?.({
					type: 'tool.call',
					toolCallId: activityId,
					tool: call.name || '(missing tool name)',
					args: parseActivityArgs(call.arguments)
				});
				const result = await dispatchExtractorToolCall(handlers, call);
				// Tag rejections by tool + error code for telemetry (see rejectionTags).
				if (!activityResultOk(result)) {
					try {
						const parsed = JSON.parse(result) as {
							tool?: string;
							error?: { code?: string };
						};
						const tag = `${parsed.tool ?? call.name}:${parsed.error?.code ?? 'unknown'}`;
						rejectionTags[tag] = (rejectionTags[tag] ?? 0) + 1;
					} catch {
						// Non-JSON failure (e.g. thrown exception); ignore for tagging.
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
					// Tool results are fed back to the (possibly external) provider
					// verbatim. We don't re-redact here: read-tool output is durable
					// memory that was already secret-filtered on write (see
					// sanitizePatch), and write-tool output only echoes the model's
					// own staged input. Thrown-exception messages ARE redacted at the
					// dispatch boundary (dispatchExtractorToolCall).
					content: truncate(result, TOOL_RESULT_MAX_CHARS)
				});
			}
		}

		const merged = mergePatchProposals(staged);
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
			hitWallClockBudget
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
		return JSON.stringify({ error: `Unknown tool: ${call.name || '(missing name)'}` });
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

function mergePatchProposals(patches: MemoryPatchProposal[]): MemoryPatchProposal {
	const merged: MemoryPatchProposal = {};
	const entities = patches.flatMap((patch) => patch.entities ?? []);
	const events = patches.flatMap((patch) => patch.events ?? []);
	const facts = patches.flatMap((patch) => patch.facts ?? []);
	const openLoops = patches.flatMap((patch) => patch.openLoops ?? []);
	// De-dupe resolutions by id (last write wins) so a loop the model staged
	// twice across calls is only resolved once.
	const resolutionById = new Map<
		string,
		NonNullable<MemoryPatchProposal['resolveOpenLoops']>[number]
	>();
	for (const patch of patches) {
		for (const resolution of patch.resolveOpenLoops ?? [])
			resolutionById.set(resolution.id, resolution);
	}
	// Union the "keep alive" set across every staged proposal. A loop reaffirmed
	// in ANY call counts as touched — the agent may spread keeps across several
	// keep_loops calls, and liveness decay runs once on this collapsed
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
export function createMemoryExtractor(opts: { model?: string | null } = {}): MemoryExtractor {
	const cfg = loadConfig();
	const wantsModel =
		cfg.MEMORY_EXTRACTOR_BACKEND === 'openai-compatible' ||
		cfg.MEMORY_EXTRACTOR_BACKEND === 'openai-compatible-tools';
	if (wantsModel) {
		const model = opts.model?.trim() || cfg.MEMORY_EXTRACTOR_MODEL;
		if (cfg.OPENAI_COMPATIBLE_BASE_URL && model) {
			if (cfg.MEMORY_EXTRACTOR_BACKEND === 'openai-compatible-tools') {
				return new ToolCallingMemoryExtractor({
					baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
					apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
					model,
					timeoutMs: cfg.MEMORY_EXTRACTOR_TIMEOUT_MS,
					maxInputChars: cfg.MEMORY_EXTRACTOR_MAX_INPUT_CHARS,
					maxToolIterations: cfg.MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS,
					maxWallClockMs: cfg.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS,
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
			backend: cfg.MEMORY_EXTRACTOR_BACKEND,
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
export function isModelBackedExtractorConfigured(opts: { model?: string | null } = {}): boolean {
	return createMemoryExtractor(opts).kind !== 'heuristic';
}

export async function extractAndCommitMemory(
	input: ExtractPatchInput
): Promise<
	ReturnType<typeof commitPatch> & { extraction: ExtractPatchResult; extractorKind: string }
> {
	const extractor = createMemoryExtractor({ model: input.extractorModel });
	// Always record which extractor actually ran. This is the definitive
	// signal when diagnosing "extraction happens but no subagent card": only
	// the `openai-compatible-tools` kind emits tool activity / a card.
	log.info('memory.extractor.selected', {
		conversationId: input.conversationId,
		kind: extractor.kind,
		model: extractor.model ?? null,
		emitsActivity: extractor.kind === 'openai-compatible-tools'
	});
	// Foundation for entity-key reuse, loop pruning, and loop liveness: the
	// extractor must see the existing durable state — crucially the open-loop
	// ids — to reuse keys and to keep/close loops by id. Callers (tests) may
	// supply their own packet; production does not, so build one here keyed on
	// the user message. Without this the single-shot extractor renders
	// "Initial packet: (none)" and is blind to existing ids.
	if (!input.initialPacket) {
		const globalMemoryEnabled =
			conversationsRepo.get(input.conversationId, input.userId)?.globalMemoryEnabled ?? false;
		input.initialPacket = buildInitialPacket(input.conversationId, input.mode, {
			query: input.userMessage.content,
			globalMemoryEnabled
		});
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
		// Defer the prior-patch revert (retry path) into `commitPatch`, which runs
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
