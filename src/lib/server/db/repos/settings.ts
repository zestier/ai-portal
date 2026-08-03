import { ulid } from '../ids';
import { getDb } from '../index';
import { loadConfig } from '../../config';
import {
	normalizeApprovalMode,
	normalizeBackendProvider,
	normalizeContextTier,
	normalizeMemoryExtractorBackend,
	normalizeSessionMode,
	normalizeThemeAccent,
	type UserSettings,
	type PermissionPolicy
} from '$lib/types';

interface SettingsRow {
	user_id: string;
	default_provider: string | null;
	default_model: string | null;
	default_workdir: string | null;
	default_mode: string | null;
	default_approval_mode: string | null;
	default_policy: string;
	theme: string;
	accent: string;
	default_memory_extractor_model: string | null;
	default_memory_extractor_backend: string | null;
	default_adversary_model: string | null;
	default_adversary_backend: string | null;
	default_context_tier: string | null;
	updated_at: number;
}

function rowToSettings(r: SettingsRow): UserSettings {
	const raw = r.default_policy;
	// Migration 008 rewrites 'allow-readonly' → 'prompt', but be defensive
	// against any straggler rows (e.g., a connection that opened before the
	// migration ran in dev HMR).
	const policy: PermissionPolicy = raw === 'allow-all' || raw === 'deny-all' ? raw : 'prompt';
	return {
		defaultProvider: normalizeBackendProvider(r.default_provider),
		defaultModel: r.default_model,
		defaultWorkdir: r.default_workdir,
		defaultConversationMode: normalizeSessionMode(r.default_mode),
		defaultApprovalMode: normalizeApprovalMode(r.default_approval_mode),
		defaultPolicy: policy,
		theme: r.theme === 'light' ? 'light' : r.theme === 'system' ? 'system' : 'dark',
		accent: normalizeThemeAccent(r.accent),
		defaultMemoryExtractorModel: r.default_memory_extractor_model ?? null,
		defaultMemoryExtractorBackend: normalizeMemoryExtractorBackend(
			r.default_memory_extractor_backend
		),
		defaultAdversaryModel: r.default_adversary_model ?? null,
		defaultAdversaryBackend: r.default_adversary_backend ?? null,
		defaultContextTier: normalizeContextTier(r.default_context_tier)
	};
}

export function get(userId: string): UserSettings | null {
	const r = getDb().prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as
		| SettingsRow
		| undefined;
	return r ? rowToSettings(r) : null;
}

/**
 * Default settings for users who have never saved a preference. Callers
 * typically use `settings.get(userId) ?? settings.defaults()` rather than
 * a synthetic-default `getOrDefault` (per the repo convention: `getX → X | null`).
 */
export function defaults(): UserSettings {
	return {
		defaultProvider: normalizeBackendProvider(loadConfig().DEFAULT_BACKEND_PROVIDER),
		defaultModel: null,
		defaultWorkdir: null,
		defaultConversationMode: 'interactive',
		defaultApprovalMode: 'ask',
		defaultPolicy: 'prompt',
		theme: 'system',
		accent: 'default',
		defaultMemoryExtractorModel: null,
		defaultMemoryExtractorBackend: null,
		defaultAdversaryModel: null,
		defaultAdversaryBackend: null,
		defaultContextTier: null
	};
}

export function save(userId: string, s: UserSettings) {
	getDb()
		.prepare(
			`INSERT INTO user_settings(
			   user_id, default_provider, default_model, default_workdir, default_mode, default_approval_mode, default_policy, theme, accent,
			   default_memory_extractor_model, default_memory_extractor_backend, default_adversary_model, default_adversary_backend, default_context_tier, updated_at
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   default_provider = excluded.default_provider,
			   default_model = excluded.default_model,
			   default_workdir = excluded.default_workdir,
			   default_mode = excluded.default_mode,
			   default_approval_mode = excluded.default_approval_mode,
			   default_policy = excluded.default_policy,
			   theme = excluded.theme,
			   accent = excluded.accent,
			   default_memory_extractor_model = excluded.default_memory_extractor_model,
			   default_memory_extractor_backend = excluded.default_memory_extractor_backend,
			   default_adversary_model = excluded.default_adversary_model,
			   default_adversary_backend = excluded.default_adversary_backend,
			   default_context_tier = excluded.default_context_tier,
			   updated_at = excluded.updated_at`
		)
		.run(
			userId,
			s.defaultProvider,
			s.defaultModel,
			s.defaultWorkdir,
			s.defaultConversationMode,
			s.defaultApprovalMode,
			s.defaultPolicy,
			s.theme,
			s.accent,
			s.defaultMemoryExtractorModel,
			s.defaultMemoryExtractorBackend,
			s.defaultAdversaryModel,
			s.defaultAdversaryBackend,
			s.defaultContextTier,
			Date.now()
		);
}

// --- Permission grants ---
//
// Schema is `permission_grants(user_id, conversation_id, tool,
// permission_kind, scope_pattern, decision, expires_at, granted_at)`
// after migration 009. `conversation_id` NULL means a user-global grant.
// Matching precedence (force-allow, deny, allow, prompt, expiry, wildcards)
// lives in the pure matcher module so it's testable without a DB.

import {
	matchGrantsDetailed,
	type GrantDecision,
	type GrantRow,
	type MatchOutcome,
	type DetailedMatchOutcome
} from '../../permissions/matcher';
import { decodeScope, encodeScope } from '$lib/permissions/scope-codec';
import { FS_PERMISSIONS, type GrantScope } from '$lib/permissions/scope-types';
import type { ParsedSegment } from '../../permissions/shell-parser';

export type GrantSource = 'seed' | 'prompt' | 'settings' | 'legacy';

interface GrantDbRow {
	user_id: string;
	conversation_id: string | null;
	tool: string;
	permission_kind: string | null;
	scope_pattern: string | null;
	scope_json: string | null;
	decision: string;
	expires_at: number | null;
	granted_at: number;
	deny_reason: string | null;
	args_hash: string | null;
	source: string | null;
}

function dbRowToGrant(r: GrantDbRow): GrantRow {
	const scope = decodeScope(r.scope_json);
	return {
		tool: r.tool,
		permissionKind: r.permission_kind,
		// A non-null structured scope that fails to decode must fail closed;
		// only true legacy rows with scope_json=NULL may fall back to scope_pattern.
		scopePattern: r.scope_json === null ? r.scope_pattern : scope ? r.scope_pattern : '\0',
		scope,
		decision: normalizeGrantDecision(r.decision),
		expiresAt: r.expires_at,
		denyReason: r.deny_reason,
		conversationId: r.conversation_id,
		argsHash: r.args_hash
	};
}

function normalizeGrantDecision(decision: string): GrantDecision {
	if (
		decision === 'allow' ||
		decision === 'force-allow' ||
		decision === 'deny' ||
		decision === 'prompt'
	) {
		return decision;
	}
	return 'deny';
}

/**
 * Pre-filter at the SQL level: return every grant for this user that
 * could possibly apply to (conversationId, tool). Filtering by kind /
 * pattern / expiry happens in app code so the matcher stays pure and
 * testable.
 *
 * `alsoTools` widens the pre-filter beyond the requested tool. A shell request
 * needs the user's fs grants in the candidate set because the `readable-paths` /
 * `writable-paths` positional kinds defer containment to them; those rows are
 * inert for the shell match itself (the matcher's tool check drops them) and
 * are only consulted through the nested fs question.
 */
function loadCandidateGrants(
	userId: string,
	conversationId: string,
	tool: string,
	alsoTools: readonly string[] = []
): GrantRow[] {
	const extra = alsoTools.filter((t) => t !== tool && t !== '*');
	const placeholders = extra.map(() => '?').join(', ');
	const rows = getDb()
		.prepare(
			`SELECT user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json,
			        decision, expires_at, granted_at, deny_reason, args_hash
			 FROM permission_grants
			 WHERE user_id = ?
			   AND (conversation_id = ? OR conversation_id IS NULL)
			   AND (tool = ? OR tool = '*'${extra.length > 0 ? ` OR tool IN (${placeholders})` : ''})
			 ORDER BY granted_at ASC, rowid ASC`
		)
		.all(userId, conversationId, tool, ...extra) as GrantDbRow[];
	return rows.map(dbRowToGrant);
}

export interface MatchGrantContext {
	/** Parsed shell command (when permissionKind === 'shell' and the
	 * parser accepted it). */
	shellSegments?: ParsedSegment[] | null;
	/** Target path for fs requests. */
	target?: string | null;
	/** Target URL for url requests. */
	url?: string | null;
	/** Every root the conversation may act inside (workspace + held leases). */
	workspaceRoots?: readonly string[] | null;
	/** SDK session workspace directory. */
	sessionWorkspaceRoot?: string | null;
	/** Directory relative shell operands resolve against; see `MatchQuery.shellCwd`. */
	shellCwd?: string | null;
	/** Canonical SHA-256 of the requested tool args. */
	argsHash?: string | null;
}

/**
 * Resolve a permission request against the user's stored grants.
 * Returns 'allow' / hard 'deny' / 'prompt' / 'none'; callers fall back to the policy
 * table when 'none'. Drops any deny-feedback the matched row carried;
 * callers that need it should use `matchGrantDetailed`.
 */
export function matchGrant(
	userId: string,
	conversationId: string,
	tool: string,
	permissionKind: string,
	scopeKey: string | null,
	ctx: MatchGrantContext = {},
	now: number = Date.now()
): MatchOutcome {
	return matchGrantDetailed(userId, conversationId, tool, permissionKind, scopeKey, ctx, now)
		.outcome;
}

/**
 * Same as `matchGrant`, but additionally returns matched grant feedback.
 * Hard-deny feedback is forwarded to the SDK as `{kind:'reject', feedback}`;
 * prompt feedback is used when the `auto-deny` approval mode rejects a
 * prompt-required request without human escalation.
 */
export function matchGrantDetailed(
	userId: string,
	conversationId: string,
	tool: string,
	permissionKind: string,
	scopeKey: string | null,
	ctx: MatchGrantContext = {},
	now: number = Date.now()
): DetailedMatchOutcome {
	const rows = loadCandidateGrants(
		userId,
		conversationId,
		tool,
		// Shell rules may defer their positional containment to the fs grants;
		// see `buildFsPathPermitted` in the matcher.
		permissionKind === 'shell' ? FS_PERMISSIONS : []
	);
	return matchGrantsDetailed(rows, {
		tool,
		permissionKind,
		scopeKey,
		shellSegments: ctx.shellSegments ?? null,
		target: ctx.target ?? null,
		url: ctx.url ?? null,
		workspaceRoots: ctx.workspaceRoots ?? null,
		sessionWorkspaceRoot: ctx.sessionWorkspaceRoot ?? null,
		shellCwd: ctx.shellCwd ?? null,
		argsHash: ctx.argsHash ?? null,
		now
	});
}

/**
 * @deprecated Backwards-compat wrapper. Returns true iff a wildcard
 * "allow this tool for anything" grant exists. New code should call
 * `matchGrant` with the runtime kind + scopeKey.
 */
export function hasGrant(userId: string, conversationId: string, tool: string): boolean {
	// Legacy callers don't know about kinds/patterns; pretend the request
	// is for whatever the grant covers by passing a wildcard scope.
	return matchGrant(userId, conversationId, tool, '*', null) === 'allow';
}

export interface AddGrantOptions {
	userId: string;
	/** NULL = user-global. */
	conversationId: string | null;
	tool: string;
	/** NULL = any kind. */
	permissionKind?: string | null;
	/** Legacy substring-glob over the derived scope key. NULL = any.
	 * Prefer `scope` for new grants. */
	scopePattern?: string | null;
	/** Structured scope. When set, scopePattern is ignored at match time. */
	scope?: GrantScope | null;
	decision?: GrantDecision;
	/** Unix ms; NULL/undefined = never expires. */
	expiresAt?: number | null;
	/** Optional feedback surfaced to the agent for deny or prompt-required grants. */
	denyReason?: string | null;
	/** Optional exact-invocation constraint. When set, request args must hash to this value. */
	argsHash?: string | null;
	source?: GrantSource;
}

export function addGrant(opts: AddGrantOptions) {
	getDb()
		.prepare(
			`INSERT INTO permission_grants(
			   user_id, conversation_id, tool, permission_kind,
			   scope_pattern, scope_json, decision, expires_at, granted_at, deny_reason, args_hash, source
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.userId,
			opts.conversationId,
			opts.tool,
			opts.permissionKind ?? null,
			opts.scopePattern ?? null,
			opts.scope ? encodeScope(opts.scope) : null,
			opts.decision ?? 'allow',
			opts.expiresAt ?? null,
			Date.now(),
			normalizeGrantDenyReason(opts.decision ?? 'allow', opts.denyReason),
			opts.argsHash ?? null,
			opts.source ?? (opts.conversationId === null ? 'settings' : 'prompt')
		);
}

export interface UpdateGrantOptions {
	tool: string;
	permissionKind?: string | null;
	scopePattern?: string | null;
	scope?: GrantScope | null;
	decision: GrantDecision;
	expiresAt?: number | null;
	denyReason?: string | null;
	source?: GrantSource;
}

/**
 * Update a grant in-place by rowid. Scoped to `userId` so users can only
 * edit their own rows; `conversation_id` and `granted_at` are preserved
 * (this is an edit, not a re-grant). Returns true iff a row matched.
 */
export function updateGrant(userId: string, id: number, opts: UpdateGrantOptions): boolean {
	const r = getDb()
		.prepare(
			`UPDATE permission_grants
			    SET tool = ?, permission_kind = ?, scope_pattern = ?, scope_json = ?,
			        decision = ?, expires_at = ?, deny_reason = ?, source = ?
			  WHERE rowid = ? AND user_id = ?`
		)
		.run(
			opts.tool,
			opts.permissionKind ?? null,
			opts.scopePattern ?? null,
			opts.scope ? encodeScope(opts.scope) : null,
			opts.decision,
			opts.expiresAt ?? null,
			normalizeGrantDenyReason(opts.decision, opts.denyReason),
			opts.source ?? 'settings',
			id,
			userId
		);
	return r.changes > 0;
}

export interface GrantSummary {
	id: number;
	conversationId: string | null;
	conversationTitle: string | null;
	tool: string;
	permissionKind: string | null;
	scopePattern: string | null;
	scope: GrantScope | null;
	decision: GrantDecision;
	expiresAt: number | null;
	grantedAt: number;
	denyReason: string | null;
	argsHash: string | null;
	source: GrantSource;
}

/**
 * Every grant the user owns, oldest expiry / newest grant first. Joins
 * `conversations` so the UI can show "in <title>" for conversation-scoped
 * rows; user-global rows return `conversationTitle = null`.
 *
 * Uses SQLite's implicit `rowid` as a stable per-row id for revocation
 * (the table has no other unique key — two identical-shape grants are
 * legal, just redundant).
 */
export function listGrantsForUser(userId: string): GrantSummary[] {
	const rows = getDb()
		.prepare(
			`SELECT pg.rowid AS id, pg.conversation_id, c.title AS conversation_title,
			        pg.tool, pg.permission_kind, pg.scope_pattern, pg.scope_json, pg.decision,
			        pg.expires_at, pg.granted_at, pg.deny_reason, pg.args_hash, pg.source
			 FROM permission_grants pg
			 LEFT JOIN conversations c ON c.id = pg.conversation_id
			 WHERE pg.user_id = ?
			 ORDER BY pg.granted_at DESC, pg.rowid DESC`
		)
		.all(userId) as Array<{
		id: number;
		conversation_id: string | null;
		conversation_title: string | null;
		tool: string;
		permission_kind: string | null;
		scope_pattern: string | null;
		scope_json: string | null;
		decision: string;
		expires_at: number | null;
		granted_at: number;
		deny_reason: string | null;
		args_hash: string | null;
		source: string | null;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: r.conversation_id,
		conversationTitle: r.conversation_title,
		tool: r.tool,
		permissionKind: r.permission_kind,
		scopePattern: r.scope_pattern,
		scope: decodeScope(r.scope_json),
		decision: normalizeGrantDecision(r.decision),
		expiresAt: r.expires_at,
		grantedAt: r.granted_at,
		denyReason: r.deny_reason,
		argsHash: r.args_hash,
		source: normalizeGrantSource(r.source)
	}));
}

function normalizeGrantSource(source: string | null): GrantSource {
	if (source === 'seed' || source === 'prompt' || source === 'settings' || source === 'legacy') {
		return source;
	}
	return 'legacy';
}

function normalizeGrantDenyReason(
	decision: GrantDecision,
	denyReason: string | null | undefined
): string | null {
	if (decision !== 'deny' && decision !== 'prompt') return null;
	const trimmed = denyReason?.trim();
	return trimmed ? trimmed.slice(0, 500) : null;
}

/**
 * Delete a single grant by rowid. Scoped to `userId` so users can only
 * revoke their own. Returns true iff a row was removed.
 */
export function revokeGrant(userId: string, id: number): boolean {
	const r = getDb()
		.prepare(`DELETE FROM permission_grants WHERE rowid = ? AND user_id = ?`)
		.run(id, userId);
	return r.changes > 0;
}

/**
 * Delete every grant owned by `userId`. Returns the number of rows removed.
 * Used by the settings page "Revoke all" action. Seed grants may be
 * re-installed on next login via `ensureSeedGrantsForUser`.
 */
export function revokeAllGrantsForUser(userId: string): number {
	const r = getDb().prepare(`DELETE FROM permission_grants WHERE user_id = ?`).run(userId);
	return r.changes;
}

/**
 * Drop grants past their TTL. The matcher already ignores expired rows at
 * read time, so this is purely housekeeping — keeping the settings page
 * from accumulating dead rows.
 */
export function pruneExpiredGrants(now: number = Date.now()): number {
	const r = getDb()
		.prepare(`DELETE FROM permission_grants WHERE expires_at IS NOT NULL AND expires_at < ?`)
		.run(now);
	return r.changes;
}

export function recordDecision(
	conversationId: string,
	tool: string,
	argsSummary: string,
	decision: PermissionDecisionRecord['decision']
) {
	const id = ulid();
	getDb()
		.prepare(
			`INSERT INTO permission_decisions(id, conversation_id, tool, args_summary, decision, decided_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(id, conversationId, tool, argsSummary, decision, Date.now());
}

export interface PermissionDecisionRecord {
	id: string;
	conversationId: string;
	conversationTitle: string | null;
	tool: string;
	argsSummary: string | null;
	decision:
		| 'allow-once'
		| 'allow-always'
		| 'deny'
		| 'deny-always'
		| 'auto-allow'
		| 'auto-deny'
		| 'auto-prompt-required'
		| 'auto-cancelled'
		| 'auto-expired';
	decidedAt: number;
}

/**
 * Most recent permission decisions across all conversations owned by
 * `userId`. Used by the settings page audit panel so users can see what
 * tools they've been approving (or denying) without spelunking SQLite.
 */
export function listRecentDecisionsForUser(userId: string, limit = 50): PermissionDecisionRecord[] {
	const rows = getDb()
		.prepare(
			`SELECT pd.id, pd.conversation_id, c.title AS conversation_title,
			        pd.tool, pd.args_summary, pd.decision, pd.decided_at
			 FROM permission_decisions pd
			 JOIN conversations c ON c.id = pd.conversation_id
			 WHERE c.user_id = ?
			 ORDER BY pd.decided_at DESC, pd.id DESC
			 LIMIT ?`
		)
		.all(userId, limit) as Array<{
		id: string;
		conversation_id: string;
		conversation_title: string | null;
		tool: string;
		args_summary: string | null;
		decision: string;
		decided_at: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: r.conversation_id,
		conversationTitle: r.conversation_title,
		tool: r.tool,
		argsSummary: r.args_summary,
		decision: r.decision as PermissionDecisionRecord['decision'],
		decidedAt: r.decided_at
	}));
}
