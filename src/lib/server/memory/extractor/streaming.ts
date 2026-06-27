/**
 * Provider transport + stream parsing for the model-backed extractors: the SSE
 * chat request used by the tool-calling extractor, the non-streaming fallback,
 * shared JSON-response reading, the streamed think-tag splitter, and the
 * extractor HTTP error. This is the layer that changes for provider quirks and
 * stream-format edge cases, independent of memory logic.
 */
import {
	fetchWithTimeout,
	jsonRequestHeaders,
	streamSseData
} from '$lib/server/providers/provider-utils';
import {
	redactEndpoint,
	excerptResponseBody,
	extractProviderErrorMessage,
	stringifyUnknown
} from './utils';
import type {
	ExtractorChatMessage,
	ExtractorToolSpec,
	ExtractorAssistantTurn,
	ExtractorStreamDelta
} from './types';

/** The provider-request fields the chat transport needs (a structural subset of
 * the tool-calling extractor options, so the extractor can pass its opts as-is). */
export interface ChatRequestOptions {
	baseUrl: string;
	apiKey?: string | null | undefined;
	model: string;
	timeoutMs: number;
	toolChoice?: 'auto' | 'required' | undefined;
}

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

export async function requestOpenAICompatibleChat(
	opts: ChatRequestOptions,
	messages: ExtractorChatMessage[],
	tools: ExtractorToolSpec[],
	onDelta?: (delta: ExtractorStreamDelta) => void,
	signal?: AbortSignal,
	toolChoice?: 'auto' | 'required'
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
				tool_choice: toolChoice ?? opts.toolChoice ?? 'auto',
				temperature: 0,
				stream: true
			}),
			...(signal !== undefined ? { signal } : {})
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

export async function readJsonResponse(res: Response): Promise<{ body: unknown; rawText: string }> {
	const rawText = await res.text().catch(() => '');
	if (!rawText) return { body: {}, rawText };
	try {
		return { body: JSON.parse(rawText), rawText };
	} catch {
		return { body: {}, rawText };
	}
}
