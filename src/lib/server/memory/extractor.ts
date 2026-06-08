import { ulid } from 'ulid';
import { log } from '$lib/server/log';
import {
	commitPatch,
	extractHeuristicPatch,
	renderMemoryPacket,
	validatePatch,
	type CommitMemoryPatchInput,
	MemoryPatchProposalSchema,
	type MemoryPatchProposal,
	type TurnMemoryPacket
} from './engine';
import { loadConfig } from '$lib/server/config';
import {
	fetchWithTimeout,
	jsonRequestHeaders,
	streamSseData
} from '$lib/server/providers/provider-utils';
import { buildMemoryTools } from '$lib/server/tools/memory';
import type { MemoryMode, Message, ToolCallRecord } from '$lib/types';
import type { MemoryToolCall } from '$lib/server/db/repos/memory';

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
	 * Optional sink for live tool-calling extractor activity, so a caller can
	 * render the background agent running. Only the tool-calling extractor
	 * emits; other extractors ignore it.
	 */
	onActivity?: ExtractorActivityEmitter;
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

export interface MemoryExtractor {
	kind: string;
	model?: string;
	extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult>;
}

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

type Diagnostic = ExtractPatchResult['diagnostics'][number];

export class MemoryExtractorHttpError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly endpoint: string;
	readonly model: string;
	readonly providerMessage: string | null;
	readonly responseBodyExcerpt: string | null;

	constructor(input: {
		status: number;
		statusText: string;
		endpoint: string;
		model: string;
		providerMessage?: string | null;
		responseBodyExcerpt?: string | null;
	}) {
		const statusText = input.statusText || 'Unknown status';
		const providerSuffix = input.providerMessage ? `: ${input.providerMessage}` : '';
		const bodySuffix =
			!input.providerMessage && input.responseBodyExcerpt ? `: ${input.responseBodyExcerpt}` : '';
		super(
			`Memory extractor request failed with HTTP ${input.status} ${statusText} for model "${input.model}" at ${input.endpoint}${providerSuffix}${bodySuffix}`
		);
		this.name = 'MemoryExtractorHttpError';
		this.status = input.status;
		this.statusText = statusText;
		this.endpoint = input.endpoint;
		this.model = input.model;
		this.providerMessage = input.providerMessage ?? null;
		this.responseBodyExcerpt = input.responseBodyExcerpt ?? null;
	}
}

interface OpenAICompatibleExtractorOptions {
	baseUrl: string;
	apiKey?: string | null;
	model: string;
	timeoutMs: number;
	maxInputChars: number;
	completeJson?: (prompt: string) => Promise<unknown>;
}

// JSON Schema mirroring the model envelope ({ patch, summary, confidence,
// diagnostics }) and MemoryPatchProposalSchema. Sent via
// `response_format: { type: 'json_schema' }` so backends like LM Studio that
// reject the legacy `json_object` type still emit structured output. Kept
// non-strict (no `additionalProperties: false` / all-required) so the model
// can omit optional sections; the Zod parse afterward remains the source of
// truth.
const MEMORY_EXTRACTOR_JSON_SCHEMA = {
	name: 'memory_patch',
	strict: false,
	schema: {
		type: 'object',
		properties: {
			summary: { type: 'string' },
			confidence: { type: 'number', minimum: 0, maximum: 1 },
			diagnostics: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						severity: { type: 'string', enum: ['info', 'warning', 'error'] },
						code: { type: 'string' },
						message: { type: 'string' }
					},
					required: ['code', 'message']
				}
			},
			patch: {
				type: 'object',
				properties: {
					entities: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								entityKey: { type: 'string' },
								entityType: { type: 'string' },
								displayName: { type: 'string' },
								summary: { type: 'string' },
								metadata: {}
							},
							required: ['entityKey', 'entityType', 'displayName']
						}
					},
					events: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								eventType: { type: 'string' },
								summary: { type: 'string' },
								payload: {},
								visibility: { type: 'string' },
								confidence: { type: 'number', minimum: 0, maximum: 1 },
								entityKey: { type: 'string' }
							},
							required: ['eventType', 'summary']
						}
					},
					facts: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								entityKey: { type: 'string' },
								predicate: { type: 'string' },
								value: {},
								visibility: { type: 'string' },
								confidence: { type: 'number', minimum: 0, maximum: 1 }
							},
							required: ['predicate', 'value']
						}
					},
					decisions: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								subject: { type: 'string' },
								decision: { type: 'string' },
								rationale: { type: 'string' }
							},
							required: ['subject', 'decision']
						}
					},
					openLoops: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								loopType: { type: 'string' },
								title: { type: 'string' },
								description: { type: 'string' },
								priority: { type: 'integer' },
								relatedEntityKeys: { type: 'array', items: { type: 'string' } }
							},
							required: ['loopType', 'title']
						}
					},
					resolveOpenLoops: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								status: { type: 'string', enum: ['resolved', 'dropped'] },
								reason: { type: 'string' }
							},
							required: ['id', 'status']
						}
					}
				}
			}
		},
		required: ['patch']
	}
} as const;

// The schema the `patch` argument of memory_propose_patch must satisfy. Echoed
// back to the extractor when a staged proposal fails Zod validation so it can
// see the expected shape (not just an opaque per-field message) and self-correct.
const PATCH_TARGET_SCHEMA = MEMORY_EXTRACTOR_JSON_SCHEMA.schema.properties.patch;

export class OpenAICompatibleMemoryExtractor implements MemoryExtractor {
	readonly kind = 'openai-compatible';
	readonly model: string;
	private readonly opts: OpenAICompatibleExtractorOptions;

	constructor(opts: OpenAICompatibleExtractorOptions) {
		this.opts = opts;
		this.model = opts.model;
	}

	async extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult> {
		const prompt = buildExtractorPrompt(input, this.opts.maxInputChars);
		const raw = this.opts.completeJson
			? await this.opts.completeJson(prompt)
			: await requestOpenAICompatibleJson(this.opts, prompt);
		const parsed = parseModelPatch(raw);
		const diagnostics: Diagnostic[] = [...parsed.diagnostics];
		const sanitized = sanitizePatch(parsed.patch, input.initialPacket);
		diagnostics.push(...sanitized.diagnostics);
		return {
			patch: sanitized.patch,
			confidence: parsed.confidence,
			summary: parsed.summary,
			diagnostics,
			rawModelOutput: raw
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
	/** Test seam: drive the tool-calling loop without a live backend. */
	chatComplete?: ExtractorChatComplete;
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
	onDelta?: (delta: ExtractorStreamDelta) => void
) => Promise<ExtractorAssistantTurn>;

const TOOL_RESULT_MAX_CHARS = 4_000;

// Upper bound on the assistant text we re-send each iteration. The model's own
// chain-of-thought is stripped before storing (see the loop), but even the
// visible text can be large with chatty local models, and it is resent on every
// subsequent request — so cap it to keep the growing transcript bounded.
const ASSISTANT_TRANSCRIPT_MAX_CHARS = 4_000;

/**
 * Agentic, tool-calling memory extractor. Instead of returning a single JSON
 * patch, a dedicated background agent stores durable memory by *calling tools*:
 * it retrieves with the read-only memory tools as needed and stages writes via
 * `memory_propose_patch`, receiving per-call validation feedback (e.g. "this
 * fact is not attached to an entity but must be") so it can self-correct with
 * full turn context — context the deterministic post-commit fixups never see.
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
		const summaries: string[] = [];
		const diagnostics: Diagnostic[] = [];
		let proposeCalls = 0;
		let rejectedProposals = 0;

		const readTools = buildMemoryTools({
			userId: input.userId,
			conversationId: input.conversationId,
			// The extractor's retrieval calls are background work, not part of
			// the user-visible turn. Leave their tool-call records unattributed
			// so they don't mix into the foreground turn's memory_tool_calls
			// ledger (which would double-count when queried by turnId).
			getTurnId: () => null,
			mode: input.mode
		}).filter((tool) => tool.name !== 'memory_propose_patch');

		const stageProposal = async (rawArgs: unknown): Promise<string> => {
			proposeCalls += 1;
			const argObj = (rawArgs ?? {}) as { summary?: unknown; patch?: unknown };
			const parsed = MemoryPatchProposalSchema.safeParse(argObj.patch ?? {});
			if (!parsed.success) {
				rejectedProposals += 1;
				// Surface the *whole* error, not just each message: include the
				// JSON path of the offending field (e.g. `facts.0.value`) and
				// Zod's own issue code, plus the target schema the `patch`
				// argument must satisfy. Without these the extractor sees an
				// opaque message like "Required" with no indication of which
				// field is wrong or what shape is expected, and tends to loop in
				// an error state it can't resolve.
				return JSON.stringify({
					staged: false,
					ok: false,
					issues: parsed.error.issues.map((issue) => ({
						severity: 'error',
						code: 'patch_schema_invalid',
						path: issue.path.length ? issue.path.join('.') : '(root)',
						zodCode: issue.code,
						message: issue.message
					})),
					targetSchema: PATCH_TARGET_SCHEMA,
					note: "The `patch` argument did not match the required schema. Each issue's `path` points at the offending field; fix those to match `targetSchema`, then call memory_propose_patch again. Nothing is committed until you finish."
				});
			}
			const validation = validatePatch(parsed.data, {
				conversationId: input.conversationId,
				mode: input.mode
			});
			// Only stage proposals that are free of errors. A proposal with
			// errors is NOT staged, so when the model resubmits a correction it
			// replaces the bad attempt instead of both being merged and
			// committed (which would duplicate items and commit superseded
			// data). Warnings keep `ok` true and are staged as-is.
			if (!validation.ok) {
				rejectedProposals += 1;
				return JSON.stringify({
					staged: false,
					ok: false,
					issues: validation.issues,
					note: 'Not staged: fix the errors above and call memory_propose_patch again. Nothing is committed until you finish.'
				});
			}
			staged.push(parsed.data);
			if (typeof argObj.summary === 'string' && argObj.summary.trim()) {
				summaries.push(argObj.summary.trim());
			}
			return JSON.stringify({
				staged: true,
				ok: true,
				issues: validation.issues,
				counts: {
					entities: parsed.data.entities?.length ?? 0,
					events: parsed.data.events?.length ?? 0,
					facts: parsed.data.facts?.length ?? 0,
					decisions: parsed.data.decisions?.length ?? 0,
					openLoops: parsed.data.openLoops?.length ?? 0,
					resolvedOpenLoops: parsed.data.resolveOpenLoops?.length ?? 0
				},
				note: 'Proposal staged. Call memory_propose_patch again to add more, or stop when nothing durable remains.'
			});
		};

		const handlers = new Map<string, (args: unknown) => Promise<string>>();
		for (const tool of readTools) handlers.set(tool.name, (args) => tool.handler(args));
		handlers.set('memory_propose_patch', stageProposal);

		const toolSpecs: ExtractorToolSpec[] = [
			...readTools.map((tool) => ({
				type: 'function' as const,
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters
				}
			})),
			buildStagingToolSpec()
		];

		const userContent = truncate(
			extractorContextSections(input).join('\n\n'),
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

			const turn = await chat(messages, toolSpecs, onDelta);
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
				const activityId = `mem_${ulid()}`;
				input.onActivity?.({
					type: 'tool.call',
					toolCallId: activityId,
					tool: call.name || '(missing tool name)',
					args: parseActivityArgs(call.arguments)
				});
				const result = await dispatchExtractorToolCall(handlers, call);
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
			stagedProposals: staged.length,
			hitIterationCap,
			hitWallClockBudget
		});
		diagnostics.push(...sanitized.diagnostics);
		diagnostics.push({
			severity: 'info',
			code: 'tool_calling_extractor',
			message: `Tool-calling extractor ran ${proposeCalls} memory_propose_patch call(s) across the turn.`
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

		const summary =
			summaries.length > 0
				? summaries.join(' ')
				: finalContent.trim() || 'Tool-calling memory extraction completed.';

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

function buildToolExtractorSystemPrompt(): string {
	return [
		'You are a dedicated background memory extractor. You run after each turn and your job is to durably store memory by calling tools. You are not answering the user; you are recording what should be remembered.',
		'Retrieve before you write: a referent mentioned this turn is very often an entity you already stored under a different surface form. Before creating any entity, call memory_search (and memory_get_entity to confirm) for the person, object, place, file, component, or concept by name AND by likely key, and reuse the existing canonical entityKey instead of minting a near-duplicate. Treat short and long forms of a name as the same entity (e.g. a bare first name vs. a full name like "character.firstname" and "character.firstname_lastname", or "auth" and "auth_service") — pick the existing key and attach new facts to it rather than creating a second one.',
		'Store by calling memory_propose_patch with a structured patch. You may call it multiple times to batch related items. Each call is validated and the result tells you whether it was accepted and lists any issues — if it reports errors, call memory_propose_patch again with corrections.',
		"Clean up duplicates you find: if a search reveals two entities that denote the same real referent (the classic case is a bare name vs. a fuller name, like character.firstname and character.firstname_lastname), call memory_merge_entities with from = the duplicate to retire and into = the canonical key to keep. This reassigns the duplicate's facts and events onto the canonical entity and retires the duplicate. Verify with memory_get_entity that they are truly the same before merging — never merge two genuinely distinct referents that merely share part of a name.",
		'Prune as well as add: call memory_get_open_loops to see existing open loops, and when this turn resolves, answers, or supersedes one, close it through the patch\'s resolveOpenLoops field (by id, status "resolved" or "dropped"). Crucially, when the user was offered options and chose one, drop the unchosen options instead of leaving them open. Adding new memory without resolving the dead loops lets them pile up.',
		'When you have stored everything durable from this turn, stop calling tools and write a brief final message summarizing what you recorded (or noting that nothing durable needed storing). That closing message is shown as the extraction session summary.'
	].join('\n\n');
}

function buildStagingToolSpec(): ExtractorToolSpec {
	return {
		type: 'function',
		function: {
			name: 'memory_propose_patch',
			description:
				'Stage durable memory updates for this turn. The server validates the patch and returns acceptance plus any issues so you can correct and re-call. Call repeatedly to add more; staged proposals are committed together when you finish.',
			parameters: {
				type: 'object',
				properties: {
					summary: { type: 'string', description: 'Short summary of the memory change.' },
					patch: MEMORY_EXTRACTOR_JSON_SCHEMA.schema.properties.patch
				},
				required: ['patch']
			}
		}
	};
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
 * Whether a tool result represents a successful tool *execution* (not whether
 * a staged patch passed validation — validation issues are normal feedback the
 * agent acts on, and the call itself still succeeded).
 */
function activityResultOk(result: string): boolean {
	try {
		const parsed = JSON.parse(result);
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof (parsed as { error?: unknown }).error === 'string'
		) {
			return false;
		}
	} catch {
		// Non-JSON output is still a successful execution.
	}
	return true;
}

function activityResultSummary(toolName: string, result: string): string {
	try {
		const parsed = JSON.parse(result) as Record<string, unknown>;
		if (typeof parsed.error === 'string') return `${toolName}: ${parsed.error}`;
		if (toolName === 'memory_propose_patch' && 'staged' in parsed) {
			if (parsed.staged !== true) {
				const issues = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
				return `not staged — ${issues} error(s) to fix`;
			}
			const counts = (parsed.counts ?? {}) as Record<string, number>;
			const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
			const warnings = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
			return `staged ${total} item(s)${warnings > 0 ? ` — ${warnings} warning(s)` : ''}`;
		}
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
	const decisions = patches.flatMap((patch) => patch.decisions ?? []);
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
	if (entities.length > 0) merged.entities = entities;
	if (events.length > 0) merged.events = events;
	if (facts.length > 0) merged.facts = facts;
	if (decisions.length > 0) merged.decisions = decisions;
	if (openLoops.length > 0) merged.openLoops = openLoops;
	if (resolutionById.size > 0) merged.resolveOpenLoops = [...resolutionById.values()];
	return merged;
}

/**
 * Stateful streaming splitter that separates inline chain-of-thought
 * (<think>…</think> / <thinking>…</thinking>) from spoken content across a
 * token stream. Each `push` returns the newly classified `think` and `visible`
 * text; tags split across chunk boundaries are handled by buffering partial
 * matches. Mirrors {@link splitThink} but incrementally for streaming.
 */
export function makeThinkStream() {
	const openTags = ['<think>', '<thinking>'];
	const closeTags = ['</think>', '</thinking>'];
	const allTags = [...openTags, ...closeTags];
	const maxLen = Math.max(...allTags.map((tag) => tag.length));
	const couldBePrefix = (s: string) => allTags.some((tag) => tag.startsWith(s));
	let inThink = false;
	let pending = '';

	const drain = (): { think: string; visible: string } => {
		let think = '';
		let visible = '';
		const append = (text: string) => {
			if (!text) return;
			if (inThink) think += text;
			else visible += text;
		};
		while (pending.length > 0) {
			const lt = pending.indexOf('<');
			if (lt === -1) {
				append(pending);
				pending = '';
				break;
			}
			append(pending.slice(0, lt));
			pending = pending.slice(lt);
			const openMatch = openTags.find((tag) => pending.startsWith(tag));
			if (openMatch) {
				inThink = true;
				pending = pending.slice(openMatch.length);
				continue;
			}
			const closeMatch = closeTags.find((tag) => pending.startsWith(tag));
			if (closeMatch) {
				inThink = false;
				pending = pending.slice(closeMatch.length);
				continue;
			}
			if (pending.length < maxLen && couldBePrefix(pending)) break;
			append('<');
			pending = pending.slice(1);
		}
		return { think, visible };
	};

	return {
		push(chunk: string): { think: string; visible: string } {
			pending += chunk;
			return drain();
		},
		flush(): { think: string; visible: string } {
			const rest = pending;
			pending = '';
			if (!rest) return { think: '', visible: '' };
			return inThink ? { think: rest, visible: '' } : { think: '', visible: rest };
		}
	};
}

interface StreamingToolCall {
	id: string;
	name: string;
	arguments: string;
}

function applyExtractorToolCallDelta(
	parts: StreamingToolCall[],
	delta: { index?: number; id?: string; function?: { name?: string; arguments?: string } },
	lastIndex: number
): number {
	// Assumes the provider tags each tool-call delta with a stable `index`
	// (OpenAI always does). When absent we reuse the last seen slot, so two
	// concurrent index-less tool calls would merge — acceptable since without
	// an index there is no way to tell them apart anyway.
	const index = typeof delta.index === 'number' ? delta.index : lastIndex >= 0 ? lastIndex : 0;
	const existing = parts[index] ?? { id: '', name: '', arguments: '' };
	if (typeof delta.id === 'string') existing.id = delta.id;
	if (typeof delta.function?.name === 'string') existing.name += delta.function.name;
	if (typeof delta.function?.arguments === 'string') existing.arguments += delta.function.arguments;
	parts[index] = existing;
	return index;
}

function dedupeToolCallIds(parts: StreamingToolCall[]): StreamingToolCall[] {
	// Guarantee unique tool-call ids within the turn. A misbehaving model can
	// emit duplicate (or empty) ids; reusing them for the matching `tool`
	// result messages would violate the chat protocol and confuse subsequent
	// iterations, so de-duplicate defensively.
	const seenIds = new Set<string>();
	return parts
		.filter((part) => part.name || part.arguments || part.id)
		.map((part, index) => {
			let id = part.id || `call_${index}`;
			if (seenIds.has(id)) id = `${id}_${index}`;
			seenIds.add(id);
			return { id, name: part.name, arguments: part.arguments };
		});
}

function deltaReasoning(source: { reasoning?: unknown; reasoning_content?: unknown }): string {
	// Providers expose chain-of-thought under different keys; accept the common
	// ones (OpenRouter `reasoning`, DeepSeek/vLLM `reasoning_content`).
	if (typeof source.reasoning === 'string') return source.reasoning;
	if (typeof source.reasoning_content === 'string') return source.reasoning_content;
	return '';
}

interface StreamChoiceMessage {
	content?: unknown;
	reasoning?: unknown;
	reasoning_content?: unknown;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

async function requestOpenAICompatibleChat(
	opts: ToolCallingExtractorOptions,
	messages: ExtractorChatMessage[],
	tools: ExtractorToolSpec[],
	onDelta?: (delta: ExtractorStreamDelta) => void
): Promise<ExtractorAssistantTurn> {
	const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const res = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: jsonRequestHeaders(opts.apiKey),
			body: JSON.stringify({
				model: opts.model,
				messages,
				tools,
				tool_choice: 'auto',
				temperature: 0,
				stream: true
			})
		},
		opts.timeoutMs
	);
	if (!res.ok || !res.body) {
		const { body, rawText } = await readJsonResponse(res);
		if (!res.ok) {
			throw new MemoryExtractorHttpError({
				status: res.status,
				statusText: res.statusText,
				endpoint: redactEndpoint(endpoint),
				model: opts.model,
				providerMessage: extractProviderErrorMessage(body),
				responseBodyExcerpt: excerptResponseBody(rawText || stringifyUnknown(body))
			});
		}
		// 2xx without a streamable body: parse the single JSON message.
		return parseNonStreamingChat(body, onDelta);
	}

	let content = '';
	let reasoning = '';
	const parts: StreamingToolCall[] = [];
	let lastIndex = -1;
	for await (const data of streamSseData(res.body)) {
		if (data === '[DONE]') break;
		let chunk: {
			choices?: Array<{ delta?: StreamChoiceMessage; message?: StreamChoiceMessage }>;
			error?: { message?: string };
		};
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}
		if (chunk.error?.message) throw new Error(chunk.error.message);
		const choice = chunk.choices?.[0];
		// Most servers stream via `delta`; some emit a full `message` per chunk.
		// Prefer whichever is present (never both): consuming both would
		// double-count content/reasoning/tool deltas if a server set both.
		const source = choice?.delta ?? choice?.message;
		if (source) {
			const c = typeof source.content === 'string' ? source.content : '';
			if (c) {
				content += c;
				onDelta?.({ content: c });
			}
			const r = deltaReasoning(source);
			if (r) {
				reasoning += r;
				onDelta?.({ reasoning: r });
			}
			for (const tc of source.tool_calls ?? []) {
				lastIndex = applyExtractorToolCallDelta(parts, tc, lastIndex);
			}
		}
	}
	return { content, toolCalls: dedupeToolCallIds(parts), reasoning: reasoning || undefined };
}

function parseNonStreamingChat(
	body: unknown,
	onDelta?: (delta: ExtractorStreamDelta) => void
): ExtractorAssistantTurn {
	const message = (body as { choices?: Array<{ message?: StreamChoiceMessage }> }).choices?.[0]
		?.message;
	const content = typeof message?.content === 'string' ? message.content : '';
	const reasoning = message ? deltaReasoning(message) : '';
	if (reasoning) onDelta?.({ reasoning });
	if (content) onDelta?.({ content });
	const parts: StreamingToolCall[] = (message?.tool_calls ?? []).map((call) => ({
		id: call.id ?? '',
		name: call.function?.name ?? '',
		arguments: call.function?.arguments ?? ''
	}));
	return {
		content,
		toolCalls: dedupeToolCallIds(parts),
		reasoning: reasoning || undefined
	};
}

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
					maxWallClockMs: cfg.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS
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
 * durable memory for each turn, so the main-model prompt should discourage
 * direct memory_propose_patch calls.
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
	const extraction = await extractor.extractPatch(input);
	const commitInput: CommitMemoryPatchInput = {
		conversationId: input.conversationId,
		mode: input.mode,
		turnId: input.turnId,
		sourceMessageId: input.assistantMessage.id,
		patch: extraction.patch,
		summary: extraction.summary
	};
	const committed = commitPatch(commitInput, {
		extractorKind: extractor.kind,
		extractorModel: extractor.model,
		extractorConfidence: extraction.confidence,
		extractorDiagnostics: extraction.diagnostics
	});
	return { ...committed, extraction, extractorKind: extractor.kind };
}

interface ModelEnvelope {
	patch?: unknown;
	summary?: unknown;
	confidence?: unknown;
	diagnostics?: unknown;
}

function parseModelPatch(raw: unknown): ExtractPatchResult {
	const envelope = parseEnvelope(raw);
	const parsed = MemoryPatchProposalSchema.safeParse(envelope.patch ?? {});
	const diagnostics: Diagnostic[] = [];
	if (!parsed.success) {
		diagnostics.push({
			severity: 'error',
			code: 'model_patch_schema_invalid',
			message: parsed.error.issues.map((issue) => issue.message).join('; ')
		});
		return {
			patch: {},
			confidence: 0,
			summary: 'Model-backed memory extraction produced invalid JSON.',
			diagnostics,
			rawModelOutput: raw
		};
	}
	for (const diagnostic of Array.isArray(envelope.diagnostics) ? envelope.diagnostics : []) {
		const normalized = normalizeDiagnostic(diagnostic);
		if (normalized) diagnostics.push(normalized);
	}
	return {
		patch: parsed.data,
		confidence: typeof envelope.confidence === 'number' ? envelope.confidence : 0.75,
		summary:
			typeof envelope.summary === 'string'
				? envelope.summary
				: 'Model-backed memory extraction completed.',
		diagnostics,
		rawModelOutput: raw
	};
}

function parseEnvelope(raw: unknown): ModelEnvelope {
	if (typeof raw === 'string') {
		const json = extractJsonObject(raw);
		if (!json) return {};
		try {
			return JSON.parse(json) as ModelEnvelope;
		} catch {
			return {};
		}
	}
	if (raw && typeof raw === 'object') {
		return raw as ModelEnvelope;
	}
	return {};
}

function normalizeDiagnostic(value: unknown): Diagnostic | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as { severity?: unknown; code?: unknown; message?: unknown };
	const severity =
		row.severity === 'error' || row.severity === 'warning' || row.severity === 'info'
			? row.severity
			: 'info';
	if (typeof row.code !== 'string' || typeof row.message !== 'string') return null;
	return { severity, code: row.code.slice(0, 100), message: row.message.slice(0, 1000) };
}

function extractJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced?.[1] ?? text;
	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	return candidate.slice(start, end + 1);
}

function sanitizePatch(
	patch: MemoryPatchProposal,
	initialPacket?: TurnMemoryPacket
): {
	patch: MemoryPatchProposal;
	diagnostics: Diagnostic[];
} {
	const diagnostics: Diagnostic[] = [];
	let removed = 0;
	const keep = <T>(items: T[] | undefined): T[] | undefined => {
		if (!items) return undefined;
		const filtered = items.filter((item) => {
			const safe = !containsSensitiveValue(item);
			if (!safe) removed++;
			return safe;
		});
		return filtered.length > 0 ? filtered : undefined;
	};
	const keepResolutions = (
		resolutions: MemoryPatchProposal['resolveOpenLoops']
	): MemoryPatchProposal['resolveOpenLoops'] => {
		if (!resolutions) return undefined;
		const cleaned = resolutions
			// An id that itself looks like a secret can't reference a real loop,
			// so drop it (and count it as removed); ids are otherwise opaque.
			.filter((resolution) => {
				const safe = !containsSensitiveValue(resolution.id);
				if (!safe) removed++;
				return safe;
			})
			// Keep the resolution (id + status) so the loop is still pruned, but
			// strip a reason that looks sensitive rather than dropping the whole
			// resolution.
			.map((resolution) => {
				if (resolution.reason && containsSensitiveValue(resolution.reason)) {
					removed++;
					return { id: resolution.id, status: resolution.status };
				}
				return resolution;
			});
		return cleaned.length > 0 ? cleaned : undefined;
	};
	const sanitized = canonicalizeEntityKeys(
		{
			entities: keep(patch.entities),
			events: keep(patch.events),
			facts: keep(patch.facts),
			decisions: keep(patch.decisions),
			openLoops: keep(patch.openLoops)
		},
		initialPacket
	);
	if (sanitized.remapped > 0) {
		diagnostics.push({
			severity: 'info',
			code: 'entity_keys_canonicalized',
			message: `${sanitized.remapped} proposed entity reference(s) were canonicalized to avoid duplicate entities.`
		});
	}
	if (sanitized.merged > 0) {
		diagnostics.push({
			severity: 'info',
			code: 'duplicate_entities_merged',
			message: `${sanitized.merged} duplicate proposed entity/entities were merged by type and display name.`
		});
	}
	const nextPatch: MemoryPatchProposal = {
		entities: sanitized.patch.entities,
		events: sanitized.patch.events,
		facts: sanitized.patch.facts,
		decisions: sanitized.patch.decisions,
		openLoops: sanitized.patch.openLoops,
		// Resolutions only reference an existing loop id plus a short free-text
		// reason. Don't drop the whole resolution if the reason trips the secret
		// filter — that would silently leave the loop open. Instead strip just
		// the offending reason (keeping id + status) so the loop is still pruned.
		resolveOpenLoops: keepResolutions(patch.resolveOpenLoops)
	};
	if (removed > 0) {
		diagnostics.push({
			severity: 'warning',
			code: 'sensitive_memory_items_removed',
			message: `${removed} proposed memory item(s) were removed because they looked like secrets or credentials.`
		});
	}
	return { patch: nextPatch, diagnostics };
}

function canonicalizeEntityKeys(
	patch: MemoryPatchProposal,
	initialPacket?: TurnMemoryPacket
): { patch: MemoryPatchProposal; remapped: number; merged: number } {
	const aliases = new Map<string, string>();
	const existingByTypedName = new Map<string, string>();
	const existingByName = new Map<string, string | null>();
	const existingByKeyTail = new Map<string, string | null>();
	const knownEntities = [
		...(initialPacket?.entities ?? []).map((entity) => ({
			entityKey: entity.entityKey,
			entityType: entity.entityType,
			displayName: entity.displayName
		})),
		...(initialPacket?.entityIndex ?? []).map((entry) => ({
			entityKey: entry.entityKey,
			entityType: entry.entityType,
			displayName: entry.displayName
		}))
	];
	for (const entity of knownEntities) {
		addAlias(aliases, entity.entityKey, entity.entityKey);
		const typedName = typedNameKey(entity.entityType, entity.displayName);
		if (typedName) existingByTypedName.set(typedName, entity.entityKey);
		setUniqueAlias(existingByName, entity.displayName, entity.entityKey);
		setUniqueAlias(
			existingByKeyTail,
			entity.entityKey.split(/[.:/_-]/).at(-1) ?? '',
			entity.entityKey
		);
	}
	for (const [alias, entityKey] of [...existingByName, ...existingByKeyTail]) {
		if (entityKey) aliases.set(alias, entityKey);
	}

	const proposedByTypedName = new Map<string, string>();
	const entityKeyMap = new Map<string, string>();
	let remapped = 0;
	let merged = 0;
	const canonicalKeyForEntity = (entity: NonNullable<MemoryPatchProposal['entities']>[number]) => {
		const existing =
			aliases.get(normalizedName(entity.entityKey)) ??
			existingByTypedName.get(typedNameKey(entity.entityType, entity.displayName)) ??
			existingByName.get(normalizedName(entity.displayName)) ??
			null;
		if (existing) return existing;
		const typedName = typedNameKey(entity.entityType, entity.displayName);
		if (typedName) {
			const proposed = proposedByTypedName.get(typedName);
			if (proposed) return proposed;
			proposedByTypedName.set(typedName, entity.entityKey);
		}
		return entity.entityKey;
	};

	const entities: NonNullable<MemoryPatchProposal['entities']> = [];
	const seenEntities = new Set<string>();
	for (const entity of patch.entities ?? []) {
		const canonicalKey = canonicalKeyForEntity(entity);
		entityKeyMap.set(entity.entityKey, canonicalKey);
		if (canonicalKey !== entity.entityKey) remapped++;
		if (seenEntities.has(canonicalKey)) {
			merged++;
			continue;
		}
		seenEntities.add(canonicalKey);
		entities.push({ ...entity, entityKey: canonicalKey });
	}

	const rewriteKey = (key: string | undefined): string | undefined => {
		if (!key) return undefined;
		const canonical = entityKeyMap.get(key) ?? aliases.get(normalizedName(key));
		if (canonical && canonical !== key) {
			remapped++;
			return canonical;
		}
		return canonical ?? key;
	};

	const next: MemoryPatchProposal = {
		events: patch.events?.map((event) => ({ ...event, entityKey: rewriteKey(event.entityKey) })),
		facts: patch.facts?.map((fact) => ({ ...fact, entityKey: rewriteKey(fact.entityKey) })),
		decisions: patch.decisions,
		openLoops: patch.openLoops?.map((loop) => ({
			...loop,
			relatedEntityKeys: loop.relatedEntityKeys?.map((key) => rewriteKey(key) ?? key)
		}))
	};
	next.entities = entities.length > 0 ? entities : undefined;
	return { patch: next, remapped, merged };
}

function addAlias(aliases: Map<string, string>, raw: string, entityKey: string): void {
	const alias = normalizedName(raw);
	if (alias) aliases.set(alias, entityKey);
}

function setUniqueAlias(aliases: Map<string, string | null>, raw: string, entityKey: string): void {
	const alias = normalizedName(raw);
	if (!alias) return;
	const prior = aliases.get(alias);
	aliases.set(alias, prior === undefined ? entityKey : prior === entityKey ? prior : null);
}

function typedNameKey(entityType: string, displayName: string): string {
	const type = normalizedName(entityType);
	const name = normalizedName(displayName);
	return type && name ? `${type}:${name}` : '';
}

function normalizedName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function containsSensitiveValue(value: unknown): boolean {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (!text) return false;
	return (
		/\bgh[psuor]_[A-Za-z0-9_]{20,}\b/.test(text) ||
		/\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/.test(text) ||
		/\b(?:bearer|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i.test(
			text
		)
	);
}

async function requestOpenAICompatibleJson(
	opts: OpenAICompatibleExtractorOptions,
	prompt: string
): Promise<unknown> {
	const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const diagnosticEndpoint = redactEndpoint(endpoint);
	const res = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: jsonRequestHeaders(opts.apiKey),
			body: JSON.stringify({
				model: opts.model,
				messages: [
					{
						role: 'system',
						content:
							'Extract durable memory as strict JSON only. Do not include prose outside JSON.'
					},
					{ role: 'user', content: prompt }
				],
				response_format: { type: 'json_schema', json_schema: MEMORY_EXTRACTOR_JSON_SCHEMA },
				temperature: 0,
				stream: false
			})
		},
		opts.timeoutMs
	);
	const { body, rawText } = await readJsonResponse(res);
	const typedBody = body as {
		choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
		error?: { message?: string };
	};
	if (!res.ok) {
		throw new MemoryExtractorHttpError({
			status: res.status,
			statusText: res.statusText,
			endpoint: diagnosticEndpoint,
			model: opts.model,
			providerMessage: extractProviderErrorMessage(body),
			responseBodyExcerpt: excerptResponseBody(rawText || stringifyUnknown(body))
		});
	}
	const content = typedBody.choices?.[0]?.message?.content ?? typedBody.choices?.[0]?.text;
	return typeof content === 'string' ? content : (content ?? {});
}

async function readJsonResponse(res: Response): Promise<{ body: unknown; rawText: string }> {
	const rawText = await res.text().catch(() => '');
	if (!rawText) return { body: {}, rawText };
	try {
		return { body: JSON.parse(rawText), rawText };
	} catch {
		return { body: {}, rawText };
	}
}

function extractProviderErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const record = body as Record<string, unknown>;
	const error = record.error;
	if (error && typeof error === 'object') {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === 'string' && message.trim()) return message.trim();
	}
	for (const key of ['message', 'detail', 'error_description']) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function excerptResponseBody(text: string): string | null {
	const normalized = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
	if (!normalized) return null;
	return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function redactEndpoint(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.username) url.username = '[redacted]';
		if (url.password) url.password = '[redacted]';
		url.search = '';
		return url.toString();
	} catch {
		return redactSensitiveText(raw);
	}
}

function stringifyUnknown(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function buildExtractorPrompt(input: ExtractPatchInput, maxInputChars: number): string {
	return truncate(
		[
			'Return JSON with this shape:',
			'{"summary":"short summary","confidence":0.0,"diagnostics":[],"patch":{"entities":[],"events":[],"facts":[],"decisions":[],"openLoops":[],"resolveOpenLoops":[]}}',
			...extractorContextSections(input)
		].join('\n\n'),
		maxInputChars
	);
}

/**
 * The shared, instruction-light context block describing the turn to extract
 * from. Both the single-shot JSON extractor and the tool-calling extractor feed
 * this to the model; only the surrounding output instructions differ.
 */
function extractorContextSections(input: ExtractPatchInput): string[] {
	return [
		'Your job: capture everything from this turn that could matter after it ends. Draw from every source — the user message, the assistant message, the recent transcript, and the tool calls — and record concrete specifics (names, exact values, conditions, qualifiers), never vague summaries. Err strongly toward over-capturing: a detail you record and never need costs little; one you drop is gone. When in doubt, include it.',
		'Sort what you capture into the right primitive — each serves a distinct purpose:\n- fact: context to KNOW — a durable attribute, relationship, state, preference, constraint, location, ownership, role, capability, deadline, dependency, identifier, or numeric value about the world, the project, or the user.\n- directive: an agent control — a standing rule for how YOU should behave going forward (your conduct, style, format, or process). Stored as a fact with predicate "directive".\n- decision: a settled choice or commitment, recorded with its subject, the decision itself, and an optional rationale.\n- open loop: an unresolved question, task, or thread awaiting follow-up.\n- event: something notable that happened this turn.\n- entity: the durable referent (person, object, file, component, topic, project concept) that facts, events, and open loops attach to.\nThe distinction that causes the most errors is fact vs directive: ask whether the user is telling you how to act from now on (directive) or telling you something to know (fact).',
		'For directives, phrasing is irrelevant — plain declarative policy ("All introduced characters are to be given names.", "Keep responses under 200 words.") is as much a directive as "always …" / "never …". One-off work for this turn ("rename this variable", "fix the bug in foo()", "add a test") is NOT a directive — record anything durable about it as a fact or decision instead. Store the rule as the directive fact\'s string value. Directives are additive and persist until retired: emit a new one per genuinely new rule, re-emit identical text only when the user reaffirms it (duplicates are de-duped), and when the user overrides a prior rule, state the full replacement (the old wording stays active until retired via the memory inspector).',
		'Keep facts granular: split each distinct detail into its own fact rather than collapsing several together. Facts, events, and open loops each attach to an entity via its canonical entityKey (decisions stand alone via their subject). Reuse an existing key from the initial packet whenever the referent already exists — do not mint a second entity for an alias, casing change, title, or partial/expanded name (a bare first name and a full name, e.g. character.firstname vs character.firstname_lastname, are the SAME entity). Create a new entity only for a durable referent not already represented, using a stable namespaced key (e.g. character.mara, object.attic_key, file.src_routes_api, component.memory_extractor, concept.append_only_migrations). A fact with no natural entity is a last resort. If unsure whether two names are the same referent, reuse the existing key and note the uncertainty in diagnostics.',
		'Prune superseded open loops: when this turn resolves, answers, or abandons an existing loop, close it via resolveOpenLoops using its [id=...] from the initial packet (or memory_get_open_loops) with status "resolved" (done/answered) or "dropped" (abandoned/superseded). When the user picks one of several offered options, drop the unchosen ones. Leaving dead loops to accumulate crowds out useful memory.',
		'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.',
		`Memory mode: ${input.mode}`,
		'Initial packet:',
		redactSensitiveText(
			input.initialPacket
				? renderMemoryPacket(input.initialPacket, { includeOpenLoopIds: true })
				: '(none)'
		),
		'Memory tool calls this turn:',
		redactSensitiveText(
			JSON.stringify(
				(input.memoryToolCalls ?? []).map((tool) => ({
					toolName: tool.toolName,
					resultSummary: tool.resultSummary,
					resultIds: tool.resultIds
				})),
				null,
				2
			)
		),
		'Regular tool calls this turn:',
		redactSensitiveText(
			JSON.stringify(
				(input.regularToolCalls ?? []).map((tool) => ({
					tool: tool.tool,
					status: tool.status
				})),
				null,
				2
			)
		),
		'User message:',
		redactSensitiveText(input.userMessage.content),
		'Assistant message:',
		redactSensitiveText(input.assistantMessage.content)
	];
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
		.replace(/\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/g, '[redacted:api-key]')
		.replace(
			/\b((?:bearer|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{12,}/gi,
			'$1[redacted]'
		);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated]`;
}
