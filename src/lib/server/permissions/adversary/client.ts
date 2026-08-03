/**
 * The Phase 0 adversary call: one OpenAI-compatible JSON completion, strictly
 * parsed into a verdict (see `./verdict` for the parser).
 *
 * Deliberately minimal and tool-less. Giving the adversary tools would recurse
 * the permission problem — who approves the reviewer's tool calls? — so it gets
 * exactly one shot at exactly the facts it was handed, with no way to gather
 * more.
 *
 * Every failure mode (transport error, timeout, prose instead of JSON, an
 * unrecognised verdict word) is reported as `{kind:'error'}` and never coerced
 * into a verdict.
 */

import { fetchWithTimeout, jsonRequestHeaders, parseJson } from '../../providers/provider-utils';
import {
	ADVERSARY_SYSTEM_PROMPT,
	ADVERSARY_PROMPT_VERSION,
	buildAdversaryPrompt,
	type AdversaryFacts
} from './prompt';
import { parseVerdict } from './verdict';
import type { AdversaryVerdict } from './scoring';
import { createHash } from 'node:crypto';

export { parseVerdict } from './verdict';

export type AdversaryOutcome =
	| {
			kind: 'verdict';
			verdict: AdversaryVerdict;
			rationale: string;
			denyProbability: number | null;
			latencyMs: number;
			/** The exact user prompt sent, so the stored evidence cannot drift. */
			promptSent: string;
	  }
	| {
			kind: 'error';
			error: string;
			/** `null` when no call was made (a skip), so it cannot enter latency stats. */
			latencyMs: number | null;
			promptSent: string;
	  };

export interface AdversaryClientOptions {
	baseUrl: string;
	apiKey?: string | null | undefined;
	model: string;
	timeoutMs: number;
	maxArgChars?: number | undefined;
	/** Test seam: bypasses HTTP and returns the raw model text. */
	complete?: ((system: string, user: string) => Promise<string>) | undefined;
}

export const ADVERSARY_JSON_SCHEMA = {
	name: 'permission_review',
	strict: false,
	schema: {
		type: 'object',
		properties: {
			verdict: { type: 'string', enum: ['allow', 'deny'] },
			denyProbability: { type: 'number', minimum: 0, maximum: 1 },
			rationale: { type: 'string' }
		},
		// `denyProbability` is required of the MODEL so it is actually supplied
		// (a column of nulls is a curve that does not exist), but the parser
		// stays tolerant of its absence — backends that ignore `response_format`
		// should still yield a usable verdict rather than an error row.
		required: ['verdict', 'denyProbability', 'rationale']
	}
} as const;

/**
 * Identity of the experiment a row belongs to. Computed from everything that
 * changes what the model was asked — system prompt text, renderer version,
 * truncation budget, model name — so rows from different setups can never be
 * pooled by accident. Deliberately not the hand-maintained
 * `ADVERSARY_PROMPT_VERSION`, which only works if someone remembers to bump it.
 *
 * Still imperfect: a model *name* can point at mutable weights, so a
 * provider-side upgrade is invisible here.
 */
export function adversaryExperimentKey(opts: { model: string; maxArgChars: number }): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				systemPrompt: ADVERSARY_SYSTEM_PROMPT,
				promptVersion: ADVERSARY_PROMPT_VERSION,
				maxArgChars: opts.maxArgChars,
				model: opts.model
			})
		)
		.digest('hex')
		.slice(0, 16);
}

const MAX_ERROR_CHARS = 500;

export async function reviewPermissionRequest(
	facts: AdversaryFacts,
	opts: AdversaryClientOptions
): Promise<AdversaryOutcome> {
	const startedAt = Date.now();
	const user = buildAdversaryPrompt(facts, opts.maxArgChars);
	let raw: string;
	try {
		raw = opts.complete
			? await opts.complete(ADVERSARY_SYSTEM_PROMPT, user)
			: await requestCompletion(opts, user);
	} catch (e) {
		return {
			kind: 'error',
			error: truncate(errorMessage(e), MAX_ERROR_CHARS),
			latencyMs: elapsed(startedAt),
			promptSent: user
		};
	}
	const parsed = parseVerdict(raw);
	if (!parsed) {
		return {
			kind: 'error',
			error: `unparseable adversary output: ${truncate(raw.trim(), 200)}`,
			latencyMs: elapsed(startedAt),
			promptSent: user
		};
	}
	return { ...parsed, latencyMs: elapsed(startedAt), promptSent: user };
}

async function requestCompletion(opts: AdversaryClientOptions, user: string): Promise<string> {
	const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const res = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: jsonRequestHeaders(opts.apiKey),
			body: JSON.stringify({
				model: opts.model,
				messages: [
					{ role: 'system', content: ADVERSARY_SYSTEM_PROMPT },
					{ role: 'user', content: user }
				],
				response_format: { type: 'json_schema', json_schema: ADVERSARY_JSON_SCHEMA },
				temperature: 0,
				stream: false
			}),
			// `fetchWithTimeout`'s own timer only guards the request up to the
			// response headers — it clears the timer as soon as `fetch` resolves.
			// Passing our own signal means the same budget also covers the body
			// read, so a provider or proxy that returns headers and then stalls
			// the body cannot leave this call pending forever (which would hold
			// an in-flight slot and eventually wedge the concurrency cap).
			signal: AbortSignal.timeout(opts.timeoutMs)
		},
		opts.timeoutMs
	);
	const body = await parseJson(res);
	if (!res.ok) {
		const message = (body as { error?: { message?: string } })?.error?.message;
		throw new Error(`adversary provider ${res.status}: ${message ?? res.statusText}`);
	}
	const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
		?.message?.content;
	if (typeof content !== 'string') throw new Error('adversary provider returned no text content');
	return content;
}

function elapsed(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message || e.name;
	return String(e);
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
