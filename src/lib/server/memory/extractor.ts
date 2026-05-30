import {
	commitPatch,
	extractHeuristicPatch,
	type CommitMemoryPatchInput,
	MemoryPatchProposalSchema,
	type MemoryPatchProposal,
	type TurnMemoryPacket
} from './engine';
import { loadConfig } from '$lib/server/config';
import {
	fetchWithTimeout,
	jsonRequestHeaders,
	parseJson
} from '$lib/server/providers/provider-utils';
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

interface OpenAICompatibleExtractorOptions {
	baseUrl: string;
	apiKey?: string | null;
	model: string;
	timeoutMs: number;
	maxInputChars: number;
	completeJson?: (prompt: string) => Promise<unknown>;
}

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
		const sanitized = sanitizePatch(parsed.patch);
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

function sanitizePatch(patch: MemoryPatchProposal): {
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
	const sanitized: MemoryPatchProposal = {
		entities: keep(patch.entities),
		events: keep(patch.events),
		facts: keep(patch.facts),
		decisions: keep(patch.decisions),
		openLoops: keep(patch.openLoops)
	};
	if (removed > 0) {
		diagnostics.push({
			severity: 'warning',
			code: 'sensitive_memory_items_removed',
			message: `${removed} proposed memory item(s) were removed because they looked like secrets or credentials.`
		});
	}
	return { patch: sanitized, diagnostics };
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
	const res = await fetchWithTimeout(
		`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
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
				response_format: { type: 'json_object' },
				temperature: 0,
				stream: false
			})
		},
		opts.timeoutMs
	);
	const body = (await parseJson(res)) as {
		choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
		error?: { message?: string };
	};
	if (!res.ok) throw new Error(body.error?.message ?? `Memory extractor failed: ${res.status}`);
	const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text;
	return typeof content === 'string' ? content : (content ?? {});
}

function buildExtractorPrompt(input: ExtractPatchInput, maxInputChars: number): string {
	return truncate(
		[
			'Return JSON with this shape:',
			'{"summary":"short summary","confidence":0.0,"diagnostics":[],"patch":{"entities":[],"events":[],"facts":[],"decisions":[],"openLoops":[]}}',
			'Only extract durable facts, decisions, open loops, events, and entities that are useful after this turn.',
			'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.',
			`Memory mode: ${input.mode}`,
			'Initial packet:',
			redactSensitiveText(JSON.stringify(input.initialPacket ?? {}, null, 2)),
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
