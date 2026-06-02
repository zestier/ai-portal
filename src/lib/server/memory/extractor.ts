import {
	commitPatch,
	extractHeuristicPatch,
	renderMemoryPacket,
	type CommitMemoryPatchInput,
	MemoryPatchProposalSchema,
	type MemoryPatchProposal,
	type TurnMemoryPacket
} from './engine';
import { loadConfig } from '$lib/server/config';
import { fetchWithTimeout, jsonRequestHeaders } from '$lib/server/providers/provider-utils';
import type { MemoryMode, Message, ToolCallRecord } from '$lib/types';
import type { MemoryToolCall } from '$lib/server/db/repos/memory';

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
					}
				}
			}
		},
		required: ['patch']
	}
} as const;

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

export function createMemoryExtractor(opts: { model?: string | null } = {}): MemoryExtractor {
	const cfg = loadConfig();
	if (cfg.MEMORY_EXTRACTOR_BACKEND === 'openai-compatible') {
		const model = opts.model?.trim() || cfg.MEMORY_EXTRACTOR_MODEL;
		if (cfg.OPENAI_COMPATIBLE_BASE_URL && model) {
			return new OpenAICompatibleMemoryExtractor({
				baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
				apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
				model,
				timeoutMs: cfg.MEMORY_EXTRACTOR_TIMEOUT_MS,
				maxInputChars: cfg.MEMORY_EXTRACTOR_MAX_INPUT_CHARS
			});
		}
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
		openLoops: sanitized.patch.openLoops
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
	for (const entity of initialPacket?.entities ?? []) {
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
			'{"summary":"short summary","confidence":0.0,"diagnostics":[],"patch":{"entities":[],"events":[],"facts":[],"decisions":[],"openLoops":[]}}',
			'Extract durable facts, decisions, open loops, events, and entities that could be useful after this turn.',
			'Be exhaustive. Your job is to capture an absolute ton of detail — err strongly toward over-capturing. It is far better to record a detail that is never needed than to lose one that is. When in doubt, include it.',
			'Prefer granular fact collection: extract each stable attribute, relationship, state, preference, constraint, location, ownership, capability, role, intent, deadline, dependency, numeric value, identifier, and project decision as its own separate fact whenever it may matter later. Do not collapse multiple details into one fact; split them.',
			'Mine every available source for detail — the user message, the assistant message, the recent transcript, and the tool calls — and record the specifics, not just summaries. Capture concrete particulars (names, exact values, conditions, qualifiers) rather than vague generalities.',
			'Reuse entityKey values from the initial packet whenever a mentioned person, object, file, component, topic, or project concept refers to an existing entity. Do not create a new entity for aliases, casing changes, titles, or partial names of the same referent.',
			'Create a new entity only for a durable referent that is not already represented. Use stable namespaced keys such as character.mara, object.attic_key, file.src_routes_api, component.memory_extractor, or decision.append_only_migrations.',
			'When adding facts/events/openLoops about an entity, use the canonical entityKey exactly. If unsure whether two names are the same referent, prefer reusing the existing key and mention uncertainty in diagnostics.',
			'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.',
			`Memory mode: ${input.mode}`,
			'Initial packet:',
			redactSensitiveText(input.initialPacket ? renderMemoryPacket(input.initialPacket) : '(none)'),
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
		].join('\n\n'),
		maxInputChars
	);
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
