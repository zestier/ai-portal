/**
 * `permission_shadow_decisions` — Phase 0 adversary shadow rows.
 *
 * A row is written in up to three steps by two independent writers:
 *
 *   1. `insertPending` at the moment the human prompt is raised (synchronous,
 *      on the permission path).
 *   2. `recordVerdict` when the fire-and-forget adversary call settles.
 *   3. `recordHumanDecision` when the human answers the dialog.
 *
 * (2) and (3) race — the human frequently clicks before a provider roundtrip
 * finishes, and either may never happen at all. Each writer therefore updates
 * only its own columns, so the outcome does not depend on their order.
 */

import { getDb } from '../index';
import { conversationId as convCodec } from '$lib/ids';
import type {
	AdversaryVerdict,
	HumanPermissionDecision,
	ShadowScoringRow
} from '../../permissions/adversary/scoring';

export type ShadowStatus = 'pending' | 'verdict' | 'error';

/** Why the request needed a decision; see the migration's column comment. */
export type ShadowResolutionSource = 'prompt-grant' | 'prompt-policy' | 'auto-approve';

export interface InsertPendingShadowOptions {
	conversationId: string | number;
	tool: string;
	permissionKind: string;
	scopeKey: string | null;
	argsHash: string | null;
	adversaryModel: string;
	experimentKey: string;
	promptVersion: number;
	factsKey: string | null;
	resolutionSource: ShadowResolutionSource | null;
}

export function insertPending(opts: InsertPendingShadowOptions): number {
	const convId = typeof opts.conversationId === 'number' ? opts.conversationId : convCodec.parse(opts.conversationId);
	const info = getDb()
		.prepare(
			`INSERT INTO permission_shadow_decisions(
			   conversation_id, tool, permission_kind, scope_key, args_hash,
			   adversary_model, experiment_key, prompt_version, facts_key,
			   resolution_source, status, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
		)
		.run(
			convId,
			opts.tool,
			opts.permissionKind,
			opts.scopeKey,
			opts.argsHash,
			opts.adversaryModel,
			opts.experimentKey,
			opts.promptVersion,
			opts.factsKey,
			opts.resolutionSource,
			Date.now()
		);
	return Number(info.lastInsertRowid);
}

export function recordVerdict(
	id: number,
	verdict: AdversaryVerdict,
	rationale: string,
	opts: {
		denyProbability?: number | null;
		latencyMs?: number | null;
		memoized?: boolean;
		promptSent?: string | null;
	} = {}
): void {
	getDb()
		.prepare(
			`UPDATE permission_shadow_decisions
			    SET status = 'verdict', verdict = ?, rationale = ?, deny_probability = ?, error = NULL,
			        latency_ms = ?, memoized = ?, prompt_sent = ?
			  WHERE id = ?`
		)
		.run(
			verdict,
			rationale,
			opts.denyProbability ?? null,
			opts.latencyMs ?? null,
			opts.memoized ? 1 : 0,
			opts.promptSent ?? null,
			id
		);
}

export function recordError(
	id: number,
	error: string,
	opts: { latencyMs?: number | null; memoized?: boolean; promptSent?: string | null } = {}
): void {
	getDb()
		.prepare(
			`UPDATE permission_shadow_decisions
			    SET status = 'error', verdict = NULL, rationale = NULL, deny_probability = NULL, error = ?,
			        latency_ms = ?, memoized = ?, prompt_sent = ?
			  WHERE id = ?`
		)
		.run(error, opts.latencyMs ?? null, opts.memoized ? 1 : 0, opts.promptSent ?? null, id);
}

/**
 * Attach the human's actual click. Never called for a cancelled or expired
 * prompt: `human_decision` stays NULL there, which the scorer reads as
 * "no label" and excludes rather than counting as a denial.
 */
export function recordHumanDecision(
	id: number,
	decision: Exclude<HumanPermissionDecision, null>
): void {
	getDb()
		.prepare(
			`UPDATE permission_shadow_decisions
			    SET human_decision = ?, human_decided_at = ?
			  WHERE id = ?`
		)
		.run(decision, Date.now(), id);
}

export interface ShadowDecisionRecord extends ShadowScoringRow {
	id: number;
	conversationId: number;
	tool: string;
	permissionKind: string;
	scopeKey: string | null;
	argsHash: string | null;
	adversaryModel: string;
	experimentKey: string;
	promptVersion: number;
	factsKey: string | null;
	promptSent: string | null;
	resolutionSource: ShadowResolutionSource | null;
	denyProbability: number | null;
	rationale: string | null;
	error: string | null;
	latencyMs: number | null;
	memoized: boolean;
	humanDecidedAt: number | null;
	createdAt: number;
}

interface ShadowDbRow {
	id: number;
	conversation_id: number;
	tool: string;
	permission_kind: string;
	scope_key: string | null;
	args_hash: string | null;
	adversary_model: string;
	experiment_key: string;
	prompt_version: number;
	facts_key: string | null;
	prompt_sent: string | null;
	resolution_source: string | null;
	status: string;
	verdict: string | null;
	deny_probability: number | null;
	rationale: string | null;
	error: string | null;
	latency_ms: number | null;
	memoized: number;
	human_decision: string | null;
	human_decided_at: number | null;
	created_at: number;
}

function normalizeStatus(status: string): ShadowStatus {
	return status === 'verdict' || status === 'error' ? status : 'pending';
}

function normalizeVerdict(verdict: string | null): AdversaryVerdict | null {
	return verdict === 'allow' || verdict === 'deny' ? verdict : null;
}

function normalizeResolutionSource(source: string | null): ShadowResolutionSource | null {
	return source === 'prompt-grant' || source === 'prompt-policy' || source === 'auto-approve'
		? source
		: null;
}

function normalizeHumanDecision(decision: string | null): HumanPermissionDecision {
	return decision === 'allow-once' ||
		decision === 'allow-always' ||
		decision === 'deny' ||
		decision === 'deny-always'
		? decision
		: null;
}

function rowToRecord(r: ShadowDbRow): ShadowDecisionRecord {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		tool: r.tool,
		permissionKind: r.permission_kind,
		scopeKey: r.scope_key,
		argsHash: r.args_hash,
		adversaryModel: r.adversary_model,
		experimentKey: r.experiment_key,
		promptVersion: r.prompt_version,
		factsKey: r.facts_key,
		promptSent: r.prompt_sent,
		resolutionSource: normalizeResolutionSource(r.resolution_source),
		status: normalizeStatus(r.status),
		verdict: normalizeVerdict(r.verdict),
		denyProbability: r.deny_probability,
		rationale: r.rationale,
		error: r.error,
		latencyMs: r.latency_ms,
		memoized: r.memoized === 1,
		humanDecision: normalizeHumanDecision(r.human_decision),
		humanDecidedAt: r.human_decided_at,
		createdAt: r.created_at
	};
}

/** Shadow rows across every conversation owned by `userId`, newest first. */
export function listForUser(userId: number, limit = 500): ShadowDecisionRecord[] {
	const rows = getDb()
		.prepare(
			`SELECT sd.*
			   FROM permission_shadow_decisions sd
			   JOIN conversations c ON c.id = sd.conversation_id
			  WHERE c.user_id = ?
			  ORDER BY sd.created_at DESC, sd.id DESC
			  LIMIT ?`
		)
		.all(userId, limit) as ShadowDbRow[];
	return rows.map(rowToRecord);
}

export function listForConversation(conversationId: string | number): ShadowDecisionRecord[] {
	const intConv = typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId);
	const rows = getDb()
		.prepare(
			`SELECT * FROM permission_shadow_decisions
			  WHERE conversation_id = ?
			  ORDER BY created_at ASC, id ASC`
		)
		.all(intConv) as ShadowDbRow[];
	return rows.map(rowToRecord);
}
