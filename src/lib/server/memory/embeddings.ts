import { createHash } from 'node:crypto';
import { loadConfig } from '$lib/server/config';
import {
	fetchWithTimeout,
	jsonRequestHeaders,
	parseJson
} from '$lib/server/providers/provider-utils';

export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1';
export const LOCAL_EMBEDDING_DIMENSIONS = 64;

export interface MemoryEmbeddingProvider {
	embed(input: {
		texts: string[];
		purpose: 'index' | 'query';
		signal?: AbortSignal;
	}): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
	model: string;
	dimensions: number;
	vectors: number[][];
}

export class LocalHashEmbeddingProvider implements MemoryEmbeddingProvider {
	async embed(input: { texts: string[]; purpose: 'index' | 'query' }): Promise<EmbeddingResult> {
		return {
			model: LOCAL_EMBEDDING_MODEL,
			dimensions: LOCAL_EMBEDDING_DIMENSIONS,
			vectors: input.texts.map((text) => localHashEmbedding(text))
		};
	}
}

export interface OpenAICompatibleEmbeddingProviderOptions {
	baseUrl: string;
	apiKey?: string | null;
	model: string;
	timeoutMs: number;
	embedJson?: (texts: string[]) => Promise<unknown>;
}

export class OpenAICompatibleEmbeddingProvider implements MemoryEmbeddingProvider {
	readonly model: string;

	constructor(private readonly opts: OpenAICompatibleEmbeddingProviderOptions) {
		this.model = opts.model;
	}

	async embed(input: {
		texts: string[];
		purpose: 'index' | 'query';
		signal?: AbortSignal;
	}): Promise<EmbeddingResult> {
		if (input.texts.length === 0) {
			return { model: this.model, dimensions: 0, vectors: [] };
		}
		const raw = this.opts.embedJson
			? await this.opts.embedJson(input.texts)
			: await requestOpenAICompatibleEmbeddings(this.opts, input.texts, input.signal);
		const vectors = parseEmbeddingVectors(raw);
		const dimensions = vectors[0]?.length ?? 0;
		return { model: this.model, dimensions, vectors };
	}
}

export function createEmbeddingProvider(): MemoryEmbeddingProvider {
	const cfg = loadConfig();
	if (
		cfg.MEMORY_EMBEDDING_PROVIDER === 'openai-compatible' &&
		cfg.OPENAI_COMPATIBLE_BASE_URL &&
		cfg.MEMORY_EMBEDDING_MODEL
	) {
		return new OpenAICompatibleEmbeddingProvider({
			baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
			apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
			model: cfg.MEMORY_EMBEDDING_MODEL,
			timeoutMs: cfg.MEMORY_EMBEDDING_TIMEOUT_MS
		});
	}
	return new LocalHashEmbeddingProvider();
}

export function textHash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		aNorm += a[i] * a[i];
		bNorm += b[i] * b[i];
	}
	if (aNorm === 0 || bNorm === 0) return 0;
	return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function localHashEmbedding(text: string): number[] {
	const vector = Array.from({ length: LOCAL_EMBEDDING_DIMENSIONS }, () => 0);
	for (const token of tokenize(text)) {
		const hash = createHash('sha256').update(token).digest();
		const index = hash[0] % LOCAL_EMBEDDING_DIMENSIONS;
		const sign = hash[1] % 2 === 0 ? 1 : -1;
		vector[index] += sign;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm === 0 ? vector : vector.map((value) => value / norm);
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_.:/-]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

async function requestOpenAICompatibleEmbeddings(
	opts: OpenAICompatibleEmbeddingProviderOptions,
	texts: string[],
	signal?: AbortSignal
): Promise<unknown> {
	const res = await fetchWithTimeout(
		`${opts.baseUrl.replace(/\/+$/, '')}/embeddings`,
		{
			method: 'POST',
			headers: jsonRequestHeaders(opts.apiKey),
			body: JSON.stringify({
				model: opts.model,
				input: texts
			}),
			signal
		},
		opts.timeoutMs
	);
	const body = await parseJson(res);
	if (!res.ok) {
		const message =
			body && typeof body === 'object' && 'error' in body
				? ((body as { error?: { message?: unknown } }).error?.message ?? res.statusText)
				: res.statusText;
		throw new Error(
			typeof message === 'string' ? message : `Embedding request failed: ${res.status}`
		);
	}
	return body;
}

function parseEmbeddingVectors(raw: unknown): number[][] {
	const data =
		raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
			? (raw as { data: unknown[] }).data
			: [];
	const vectors = data
		.map((row) => {
			if (!row || typeof row !== 'object') return [];
			const embedding = (row as { embedding?: unknown }).embedding;
			return Array.isArray(embedding)
				? embedding.filter((value): value is number => typeof value === 'number')
				: [];
		})
		.filter((vector) => vector.length > 0);
	if (vectors.length === 0) throw new Error('Embedding response did not include vectors.');
	return vectors;
}
