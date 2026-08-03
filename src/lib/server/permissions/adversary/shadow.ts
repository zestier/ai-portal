/**
 * Phase 0 shadow-mode orchestration.
 *
 * ## The one invariant
 *
 * **The adversary has no authority and no influence.** Everything here is
 * fire-and-forget: the human dialog is raised and awaited exactly as it was
 * before this module existed, and an adversary that errors, hangs forever, or
 * returns garbage changes nothing about the request. `observe()` is
 * total — it swallows every failure, including a database that refuses the
 * insert — because the alternative is a measurement experiment able to break
 * the permission path it is measuring.
 *
 * ## Where it is called
 *
 * Immediately before the human permission prompt in `decideCore`. By
 * construction that site is only reachable in `ask` conversations:
 * `auto-approve` has already returned an allow, and `auto-deny` has already
 * rejected. `always-prompt` dialogs (notably `request_permission_grant`) and
 * forced-escalation dialogs are raised earlier and are deliberately NOT
 * shadowed — an adversary could never settle those, so scoring them would
 * dilute the precision/recall number with a population the mode can't serve.
 */

import { loadConfig } from '../../config';
import { log } from '../../log';
import { ulid } from '../../db/ids';
import * as shadowRepo from '../../db/repos/shadow-decisions';
import type { ShadowResolutionSource } from '../../db/repos/shadow-decisions';
import { BoundedTtlCache } from '../../copilot/bounded-ttl-cache';
import { withTimeout } from '../../runtime/with-timeout';
import { reviewPermissionRequest, adversaryExperimentKey, type AdversaryOutcome } from './client';
import {
	buildAdversaryFacts,
	ADVERSARY_PROMPT_VERSION,
	type BuildAdversaryFactsInput
} from './prompt';
import type { HumanPermissionDecision } from './scoring';
import { createHash } from 'node:crypto';

/** Identical requests inside this window reuse one provider call. */
const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX_ENTRIES = 200;
/**
 * Added to the client's own timeout before the in-flight slot is force-released.
 * The client should always settle first; this only exists so nothing can wedge
 * the concurrency cap for the life of the session.
 */
const SLOT_RELEASE_GRACE_MS = 5_000;
/** Marks a row where the cap prevented a call, so readouts can exclude it. */
export const SKIPPED_PREFIX = 'skipped: ';

export interface ShadowObserveInput extends BuildAdversaryFactsInput {
	conversationId: string;
	argsHash: string | null;
	/** Why this request needed a human. Recorded to characterize the sample. */
	resolutionSource?: ShadowResolutionSource | undefined;
	/**
	 * The conversation's agent model. Used only to refuse running the adversary
	 * on the same model as the agent; `null` means "unknown", which we treat as
	 * safe to proceed since the shadow has no authority either way.
	 */
	agentModel?: string | null | undefined;
}

/** Returned per observed request so the caller can attach the human's answer. */
export interface ShadowHandle {
	/**
	 * Record what the human actually clicked. Deliberately NOT called when the
	 * prompt is cancelled or expires — the row keeps `human_decision = NULL`
	 * and the scorer excludes it. A cancelled prompt is not a denial.
	 */
	recordHuman(decision: Exclude<HumanPermissionDecision, null>): void;
}

export interface ShadowRecorder {
	observe(input: ShadowObserveInput): ShadowHandle | null;
}

interface ResolvedShadowConfig {
	baseUrl: string;
	apiKey: string | undefined;
	model: string;
	timeoutMs: number;
	maxArgChars: number;
	maxInFlight: number;
}

export interface CreateShadowRecorderOptions {
	/**
	 * The conversation's effective adversary model (per-conversation override,
	 * else the user's default). Returning null/undefined falls back to the
	 * server default (`ADVERSARY_SHADOW_MODEL`); unset everywhere means the
	 * shadow is off.
	 *
	 * A getter rather than a value so a mid-session change takes effect on the
	 * next request, matching how the adapter reads approval mode.
	 */
	getModel?: (() => string | null | undefined) | undefined;
	/** Test seam: replaces the HTTP call with a canned completion. */
	complete?: ((system: string, user: string) => Promise<string>) | undefined;
	/** Test seam: notified once a shadow row has been fully written. */
	onSettled?: ((outcome: AdversaryOutcome) => void) | undefined;
}

/**
 * One recorder per provider session, so the memo cache is scoped to the
 * conversation that produced the requests.
 */
export function createShadowRecorder(opts: CreateShadowRecorderOptions = {}): ShadowRecorder {
	// Cached per identical request so a retry loop asking the same thing five
	// times costs one provider call. The key is a hash of the ENTIRE fact set
	// the model is shown, not just tool + scope key: `workspaceRoots` changes
	// mid-session as worktree leases come and go, and it is the single fact the
	// system prompt tells the reviewer to judge against, so a narrower key
	// would replay one verdict across two genuinely different questions. The
	// same hash is persisted as `facts_key` so repeat askings can be clustered
	// during analysis — they are not independent samples.
	//
	// Only *verdicts* are cached; a transient provider failure is evicted so
	// the next identical request retries rather than inheriting the error for
	// the whole TTL.
	const memo = new BoundedTtlCache<string, Promise<AdversaryOutcome>>({
		ttlMs: MEMO_TTL_MS,
		maxEntries: MEMO_MAX_ENTRIES
	});
	let warnedDisabled = false;
	// Bounds simultaneous provider calls. Without it an `auto-approve`
	// conversation — where no dialog paces the requests — can open one
	// completion per shell command the agent issues.
	let inFlight = 0;

	const observe = (input: ShadowObserveInput): ShadowHandle | null => {
		const cfg = resolveConfig(opts.getModel?.());
		if (!cfg) return null;
		if (input.agentModel && input.agentModel === cfg.model) {
			if (!warnedDisabled) {
				warnedDisabled = true;
				log.warn('adversary.shadow_skipped_same_model', {
					model: cfg.model,
					reason:
						'adversary model equals the agent model; a shared-weights reviewer measures self-agreement, not oversight'
				});
			}
			return null;
		}

		const facts = buildAdversaryFacts(input);
		// Hash of the fact set, used both as the memo key and as `facts_key` so
		// repeat askings of one question can be clustered during analysis. The
		// facts themselves are NOT persisted here — the prompt actually sent is,
		// once the call settles, so the copy at rest is bounded by the same
		// truncation budget as the network payload.
		const key = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
		const id = ulid();
		try {
			shadowRepo.insertPending({
				id,
				conversationId: input.conversationId,
				tool: input.tool,
				permissionKind: input.permissionKind,
				scopeKey: input.scopeKey,
				argsHash: input.argsHash,
				adversaryModel: cfg.model,
				experimentKey: adversaryExperimentKey({
					model: cfg.model,
					maxArgChars: cfg.maxArgChars
				}),
				promptVersion: ADVERSARY_PROMPT_VERSION,
				factsKey: key,
				resolutionSource: input.resolutionSource ?? null
			});
		} catch (e) {
			log.warn('adversary.shadow_insert_failed', {
				conversationId: input.conversationId,
				err: String(e)
			});
			return null;
		}

		const cached = memo.get(key);
		const memoized = cached !== undefined;
		let pending: Promise<AdversaryOutcome>;
		if (cached) {
			pending = cached;
		} else if (inFlight >= cfg.maxInFlight) {
			// Over the concurrency cap. Recorded as an explicit skip rather than
			// silently dropped: the hole it leaves in the sample is not random —
			// it lands on exactly the busiest moments — so it has to be visible
			// in the data. `latencyMs` is null because no call was made; a zero
			// would enter the latency percentiles and make the adversary look
			// fastest exactly when it was being throttled.
			pending = Promise.resolve({
				kind: 'error',
				error: `${SKIPPED_PREFIX}${cfg.maxInFlight} adversary calls already in flight`,
				latencyMs: null,
				promptSent: ''
			});
			// Deliberately not memoized: a skip is not a verdict, and caching it
			// would suppress the real answer for the whole TTL.
		} else {
			inFlight++;
			pending = withTimeout(
				reviewPermissionRequest(facts, {
					baseUrl: cfg.baseUrl,
					apiKey: cfg.apiKey,
					model: cfg.model,
					timeoutMs: cfg.timeoutMs,
					maxArgChars: cfg.maxArgChars,
					complete: opts.complete
				}),
				// Belt and braces over the client's own budget. The client bounds
				// its HTTP call, but this guarantees the in-flight slot is
				// released on wall-clock alone, so no provider behaviour (or
				// injected `complete` seam) can wedge the concurrency cap.
				cfg.timeoutMs + SLOT_RELEASE_GRACE_MS,
				'adversary shadow review'
			)
				.catch(
					// `reviewPermissionRequest` is written not to reject, but the
					// timeout above can, and a rejected promise parked in the memo
					// cache would be replayed to every later identical request.
					(e): AdversaryOutcome => ({
						kind: 'error',
						error: String(e),
						latencyMs: null,
						promptSent: ''
					})
				)
				.finally(() => {
					inFlight--;
				});
			memo.set(key, pending);
		}

		// Fire-and-forget. Nothing downstream of this point is awaited by the
		// permission path; the human dialog is raised by the caller regardless.
		void pending.then(
			(outcome) => {
				if (outcome.kind === 'error') memo.delete(key);
				persistOutcome(id, outcome, memoized);
				opts.onSettled?.(outcome);
			},
			() => {
				/* unreachable: normalized above */
			}
		);

		return {
			recordHuman(decision) {
				try {
					shadowRepo.recordHumanDecision(id, decision);
				} catch (e) {
					log.warn('adversary.shadow_human_label_failed', { id, err: String(e) });
				}
			}
		};
	};

	return {
		observe(input) {
			// Belt and braces: `observe` sits directly on the permission path,
			// so it must not throw even if something above is wrong (a bad
			// config shape, a closed database handle).
			try {
				return observe(input);
			} catch (e) {
				log.warn('adversary.shadow_observe_failed', {
					conversationId: input.conversationId,
					err: String(e)
				});
				return null;
			}
		}
	};
}

function persistOutcome(id: string, outcome: AdversaryOutcome, memoized: boolean): void {
	// An empty prompt means we never got as far as building one (only the
	// defensive rejection normalizer produces that). Store NULL rather than an
	// empty string so "no evidence" is not mistaken for "the model was sent
	// nothing".
	const promptSent = outcome.promptSent || null;
	try {
		if (outcome.kind === 'verdict') {
			shadowRepo.recordVerdict(id, outcome.verdict, outcome.rationale, {
				denyProbability: outcome.denyProbability,
				latencyMs: outcome.latencyMs,
				memoized,
				promptSent
			});
		} else {
			shadowRepo.recordError(id, outcome.error, {
				latencyMs: outcome.latencyMs,
				memoized,
				promptSent
			});
		}
	} catch (e) {
		log.warn('adversary.shadow_verdict_persist_failed', { id, err: String(e) });
	}
}

/**
 * Resolve the effective adversary configuration.
 *
 * Model precedence mirrors the memory extractor's: the conversation's effective
 * model (per-conversation override, else the user's default) wins, then the
 * server default. A configured model IS the enablement — no model anywhere
 * means the shadow simply never runs, which is the default.
 */
function resolveConfig(conversationModel?: string | null): ResolvedShadowConfig | null {
	const cfg = loadConfig();
	const model = conversationModel?.trim() || cfg.ADVERSARY_SHADOW_MODEL?.trim();
	// No model configured anywhere is the OFF state, not a misconfiguration:
	// it is the default for every deployment that never opts in, so warning
	// about it would be noise.
	if (!model) return null;
	if (!cfg.OPENAI_COMPATIBLE_BASE_URL) {
		// A model WAS chosen but the endpoint it needs is missing — that is a
		// real misconfiguration, and silently doing nothing would look like the
		// feature is broken rather than unconfigured.
		warnMisconfigured();
		return null;
	}
	return {
		baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL,
		apiKey: cfg.OPENAI_COMPATIBLE_API_KEY,
		model,
		timeoutMs: cfg.ADVERSARY_SHADOW_TIMEOUT_MS,
		maxArgChars: cfg.ADVERSARY_SHADOW_MAX_ARG_CHARS,
		maxInFlight: cfg.ADVERSARY_SHADOW_MAX_IN_FLIGHT
	};
}

// Process-wide so a configured-but-unreachable deployment says so once rather
// than once per permission dialog.
let warnedMisconfigured = false;
function warnMisconfigured(): void {
	if (warnedMisconfigured) return;
	warnedMisconfigured = true;
	log.warn('adversary.shadow_misconfigured', {
		reason:
			'an adversary model is configured but OPENAI_COMPATIBLE_BASE_URL is not set; the shadow cannot run'
	});
}
