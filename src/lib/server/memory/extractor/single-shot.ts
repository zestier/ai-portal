/**
 * The single-shot JSON memory extractor: one model call that returns the whole
 * patch as structured JSON (response_format json_schema), plus the envelope/JSON
 * parsing and the HTTP request it needs. A separate backend from the agentic
 * tool-calling extractor; the two change independently.
 */
import {
	coerceMemoryPatchInput,
	MEMORY_PATCH_JSON_SCHEMA,
	MemoryPatchProposalSchema
} from '../engine';
import { fetchWithTimeout, jsonRequestHeaders } from '$lib/server/providers/provider-utils';
import {
	redactEndpoint,
	excerptResponseBody,
	extractProviderErrorMessage,
	stringifyUnknown
} from './utils';
import { MemoryExtractorHttpError, readJsonResponse } from './streaming';
import { sanitizePatch } from './sanitize';
import { buildExtractorPrompt } from './prompts';
import { log } from '$lib/server/log';
import type { ExtractPatchInput, ExtractPatchResult, Diagnostic, MemoryExtractor } from './types';

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
			patch: MEMORY_PATCH_JSON_SCHEMA
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
			: await requestOpenAICompatibleJson(this.opts, prompt, input.signal);
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

interface ModelEnvelope {
	patch?: unknown;
	summary?: unknown;
	confidence?: unknown;
	diagnostics?: unknown;
}

function parseModelPatch(raw: unknown): ExtractPatchResult {
	const envelope = parseEnvelope(raw);
	const coerced = coerceMemoryPatchInput(envelope.patch ?? {});
	const parsed = MemoryPatchProposalSchema.safeParse(coerced.patch);
	const diagnostics: Diagnostic[] = [];
	for (const warning of coerced.warnings) {
		diagnostics.push({ severity: 'info', code: 'model_patch_auto_repaired', message: warning });
	}
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
		} catch (error) {
			log.warn('memory.extractor.single_shot_json_parse_failed', {
				error: error instanceof Error ? error.message : String(error)
			});
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
	if (start === -1) return null;
	// Depth-counting scan from the first `{` to its matching `}`, so trailing
	// prose after the JSON object (e.g. `{...} Let me know if...`) is ignored.
	// Track string state and escapes so braces inside string values don't count.
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < candidate.length; i++) {
		const char = candidate[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) return candidate.slice(start, i + 1);
		}
	}
	return null;
}

async function requestOpenAICompatibleJson(
	opts: OpenAICompatibleExtractorOptions,
	prompt: string,
	signal?: AbortSignal
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
			}),
			signal
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
