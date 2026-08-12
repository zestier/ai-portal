/**
 * The Phase 0 adversary call: one tool-less completion, strictly parsed into a
 * verdict (see `./verdict` for the parser).
 *
 * Transport is the provider's `complete()` capability, so the reviewer runs on
 * whichever backend was chosen for it — including the conversation's own. This
 * module owns only the prompt, the parsing, and the failure contract.
 *
 * Deliberately tool-less. Giving the adversary tools would recurse the
 * permission problem — who approves the reviewer's tool calls? — so it gets
 * exactly one shot at exactly the facts it was handed, with no way to gather
 * more.
 *
 * Every failure mode (transport error, timeout, prose instead of JSON, an
 * unrecognised verdict word) is reported as `{kind:'error'}` and never coerced
 * into a verdict.
 */

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
	/** The pi model selection (`providerId/modelId`) serving the reviewer. */
	model: string;
	timeoutMs: number;
	maxArgChars?: number | undefined;
	/** Per-user identity for backends whose auth/entitlements are per-user. */
	userId?: string | undefined;
	/** Performs the actual completion. Injected so this module owns no transport. */
	complete: (req: {
		system: string;
		user: string;
		model: string;
		timeoutMs: number;
		responseSchema: { name: string; schema: unknown };
		userId?: string | undefined;
	}) => Promise<string>;
}

export const ADVERSARY_JSON_SCHEMA = {
	name: 'permission_review',
	schema: {
		type: 'object',
		properties: {
			verdict: { type: 'string', enum: ['allow', 'deny'] },
			denyProbability: { type: 'number', minimum: 0, maximum: 1 },
			rationale: { type: 'string' }
		},
		// `denyProbability` is required of the MODEL so it is actually supplied
		// (a column of nulls is a curve that does not exist), but the parser
		// stays tolerant of its absence — backends that ignore the schema, or
		// cannot enforce one at all (a session that ignores the schema), should still
		// yield a usable verdict rather than an error row.
		required: ['verdict', 'denyProbability', 'rationale']
	}
} as const;

/**
 * Identity of the experiment a row belongs to. Computed from everything that
 * changes what the model was asked — system prompt text, renderer version,
 * truncation budget, model selection — so rows from different setups can never
 * be pooled by accident. Deliberately not the hand-maintained
 * `ADVERSARY_PROMPT_VERSION`, which only works if someone remembers to bump it.
 *
 * The model selection is provider-qualified (`providerId/modelId`), so the
 * backend separation that used to be an explicit part of the key is embedded
 * in the model string: the same model *name* served by two providers differs
 * in weights, system-prompt handling and structured-output support, so those
 * are different experiments.
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
		raw = await opts.complete({
			system: ADVERSARY_SYSTEM_PROMPT,
			user,
			model: opts.model,
			timeoutMs: opts.timeoutMs,
			responseSchema: ADVERSARY_JSON_SCHEMA,
			userId: opts.userId
		});
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
