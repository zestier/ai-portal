import { getDb } from '../../index';
import { conversationId } from '$lib/ids';
import {
	matchGrantsDetailed,
	type GrantDecision,
	type GrantRow,
	type MatchOutcome,
	type DetailedMatchOutcome
} from '../../../permissions/matcher';
import { canonicalWorkspaceRoot } from '../../../permissions/repo-root';
import { decodeScope, encodeScope } from '$lib/permissions/scope-codec';
import { FS_PERMISSIONS, type GrantScope } from '$lib/permissions/scope-types';
import { isGrantTool } from '$lib/permissions/metadata';
import type { ParsedSegment } from '../../../permissions/shell-parser';
import type { WorkspaceFileGrant } from '../../../permissions/workspace-file-format';
import {
	convInt,
	dbRowToGrant,
	normalizeGrantDecision,
	normalizeGrantDenyReason,
	normalizeGrantSource,
	type GrantDbRow,
	type GrantSource
} from './rows';

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
 *
 * `workspaceRoots` scopes the checked-in `.zap/permissions.toml` rows to the
 * conversation's current workspace roots. File grants are stored with a
 * `workspace_root` and must only match requests made inside that root. When
 * the caller cannot say which roots the request applies to (empty/null), the
 * file rows are excluded entirely — fail closed, never matched globally.
 */
function loadCandidateGrants(
	userId: number,
	conversationId: number,
	tool: string,
	alsoTools: readonly string[] = [],
	workspaceRoots: readonly string[] | null = null
): GrantRow[] {
	const extra = alsoTools.filter((t) => t !== tool && t !== '*');
	const placeholders = extra.map(() => '?').join(', ');
	const rootFilter =
		workspaceRoots && workspaceRoots.length > 0
			? ` AND (COALESCE(source, '') <> 'workspace-file' OR workspace_root IN (${workspaceRoots.map(() => '?').join(', ')}))`
			: ` AND COALESCE(source, '') <> 'workspace-file'`;
	const rows = getDb()
		.prepare(
			`SELECT user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json,
			        decision, expires_at, granted_at, deny_reason, args_hash, source, workspace_root
			 FROM permission_grants
			 WHERE user_id = ?
			   AND (conversation_id = ? OR conversation_id IS NULL)
			   AND (tool = ? OR tool = '*'${extra.length > 0 ? ` OR tool IN (${placeholders})` : ''})${rootFilter}
			 ORDER BY granted_at ASC, rowid ASC`
		)
		.all(
			userId,
			conversationId,
			tool,
			...extra,
			...(workspaceRoots && workspaceRoots.length > 0 ? [...workspaceRoots] : [])
		) as GrantDbRow[];
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
	userId: number,
	conversationId: string | number,
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
	userId: number,
	conversationId: string | number,
	tool: string,
	permissionKind: string,
	scopeKey: string | null,
	ctx: MatchGrantContext = {},
	now: number = Date.now()
): DetailedMatchOutcome {
	const intConv = convInt(conversationId) ?? -1;
	const rows = loadCandidateGrants(
		userId,
		intConv,
		tool,
		// Grants are keyed by the canonical permission vocabulary
		// (`shell`/`read`/`write`/`edit`/`url`) or by the tool's own name
		// (`Bash`/`web_fetch`), depending on how the row was created. Load both
		// so a saved seed/settings-form grant matches an SDK built-in request
		// whose tool name differs from its kind; the matcher's `toolMatches`
		// accepts either vocabulary.
		[
			...(isGrantTool(permissionKind) ? [permissionKind] : []),
			// Shell rules may defer their positional containment to the fs grants;
			// see `buildFsPathPermitted` in the matcher.
			...(permissionKind === 'shell' ? FS_PERMISSIONS : [])
		],
		// File rows are keyed by the repository's canonical root (see
		// `applyWorkspaceFile`), so the request roots are canonicalized too —
		// one approval applies to every worktree/lease of the repo.
		ctx.workspaceRoots ? ctx.workspaceRoots.map(canonicalWorkspaceRoot) : null
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
export function hasGrant(userId: number, conversationId: string | number, tool: string): boolean {
	// Legacy callers don't know about kinds/patterns; pretend the request
	// is for whatever the grant covers by passing a wildcard scope.
	return matchGrant(userId, conversationId, tool, '*', null) === 'allow';
}

export interface AddGrantOptions {
	userId: number;
	/** NULL = user-global. */
	conversationId: string | number | null;
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
	/**
	 * Workspace root a `.zap/permissions.toml` row belongs to. Only set for
	 * `source: 'workspace-file'` rows; everything else leaves it NULL (and the
	 * matcher's workspace filter therefore lets them through).
	 */
	workspaceRoot?: string | null;
}

export function addGrant(opts: AddGrantOptions) {
	getDb()
		.prepare(
			`INSERT INTO permission_grants(
			   user_id, conversation_id, tool, permission_kind,
			   scope_pattern, scope_json, decision, expires_at, granted_at, deny_reason, args_hash, source, workspace_root
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.userId,
			convInt(opts.conversationId),
			opts.tool,
			opts.permissionKind ?? null,
			opts.scopePattern ?? null,
			opts.scope ? encodeScope(opts.scope) : null,
			opts.decision ?? 'allow',
			opts.expiresAt ?? null,
			Date.now(),
			normalizeGrantDenyReason(opts.decision ?? 'allow', opts.denyReason),
			opts.argsHash ?? null,
			opts.source ?? (opts.conversationId === null ? 'settings' : 'prompt'),
			opts.workspaceRoot ?? null
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
export function updateGrant(userId: number, id: number, opts: UpdateGrantOptions): boolean {
	// Workspace-file rows are owned by the `.zap/permissions.toml` lifecycle,
	// not the user: editing one through Settings would flip its source to
	// 'settings' and silently promote a root-scoped checked-in grant to a
	// permanent user-global one. The WHERE clause refuses them (no-op → false).
	const r = getDb()
		.prepare(
			`UPDATE permission_grants
			    SET tool = ?, permission_kind = ?, scope_pattern = ?, scope_json = ?,
			        decision = ?, expires_at = ?, deny_reason = ?, source = ?
			  WHERE rowid = ? AND user_id = ?
			    AND COALESCE(source, '') <> 'workspace-file'`
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
	/** Workspace root a `workspace-file` row belongs to; null otherwise. */
	workspaceRoot: string | null;
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
export function listGrantsForUser(userId: number): GrantSummary[] {
	const rows = getDb()
		.prepare(
			`SELECT pg.rowid AS id, pg.conversation_id, c.title AS conversation_title,
			        pg.tool, pg.permission_kind, pg.scope_pattern, pg.scope_json, pg.decision,
			        pg.expires_at, pg.granted_at, pg.deny_reason, pg.args_hash, pg.source,
			        pg.workspace_root
			 FROM permission_grants pg
			 LEFT JOIN conversations c ON c.id = pg.conversation_id
			 WHERE pg.user_id = ?
			 ORDER BY pg.granted_at DESC, pg.rowid DESC`
		)
		.all(userId) as Array<{
		id: number;
		conversation_id: number | null;
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
		workspace_root: string | null;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: r.conversation_id === null ? null : conversationId.encode(r.conversation_id),
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
		source: normalizeGrantSource(r.source),
		workspaceRoot: r.workspace_root
	}));
}

// --- Workspace permissions file (.zap/permissions.toml) ---

export interface WorkspacePermissionState {
	snapshotText: string;
	contentHash: string;
	updatedAt: number;
}

export function getWorkspacePermissionState(
	userId: number,
	workspaceRoot: string
): WorkspacePermissionState | null {
	const row = getDb()
		.prepare(
			`SELECT snapshot_text, content_hash, updated_at FROM workspace_permission_state
			 WHERE user_id = ? AND workspace_root = ?`
		)
		.get(userId, workspaceRoot) as
		| { snapshot_text: string; content_hash: string; updated_at: number }
		| undefined;
	if (!row) return null;
	return {
		snapshotText: row.snapshot_text,
		contentHash: row.content_hash,
		updatedAt: row.updated_at
	};
}

export function clearWorkspacePermissionState(userId: number, workspaceRoot: string): void {
	getDb()
		.prepare(`DELETE FROM workspace_permission_state WHERE user_id = ? AND workspace_root = ?`)
		.run(userId, workspaceRoot);
}

export function clearWorkspacePermissionStateForUser(userId: number): void {
	getDb().prepare(`DELETE FROM workspace_permission_state WHERE user_id = ?`).run(userId);
}

/**
 * Apply the "file deleted" decision atomically: revoke the workspace's file
 * grants and drop the approval state in one transaction, so a crash can't
 * leave active rows with no snapshot (or a snapshot with no rows).
 */
export function clearWorkspaceFileState(userId: number, workspaceRoot: string): number {
	let removed = 0;
	getDb().transaction(() => {
		removed = revokeWorkspaceFileGrants(userId, workspaceRoot);
		clearWorkspacePermissionState(userId, workspaceRoot);
	})();
	return removed;
}

export function countWorkspaceFileGrants(userId: number, workspaceRoot: string): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS n FROM permission_grants
			 WHERE user_id = ? AND source = 'workspace-file' AND workspace_root = ?`
		)
		.get(userId, workspaceRoot) as { n: number };
	return row.n;
}

export function revokeWorkspaceFileGrants(userId: number, workspaceRoot: string): number {
	const r = getDb()
		.prepare(
			`DELETE FROM permission_grants WHERE user_id = ? AND source = 'workspace-file' AND workspace_root = ?`
		)
		.run(userId, workspaceRoot);
	return r.changes;
}

/**
 * Atomically replace a workspace's file grants and record the approved
 * snapshot. `snapshotText` is the exact file text the human approved and
 * `contentHash` its SHA-256, so the gate can later detect drift. Returns the
 * number of grants materialized.
 */
export function replaceWorkspaceFileGrants(
	userId: number,
	workspaceRoot: string,
	grants: WorkspaceFileGrant[],
	snapshotText: string,
	contentHash: string
): number {
	const now = Date.now();
	const insert = getDb().prepare(
		`INSERT INTO permission_grants(
		   user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json,
		   decision, expires_at, granted_at, deny_reason, args_hash, source, workspace_root
		 ) VALUES (?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, 'workspace-file', ?)`
	);
	getDb().transaction(() => {
		revokeWorkspaceFileGrants(userId, workspaceRoot);
		for (const g of grants) {
			insert.run(
				userId,
				g.tool,
				g.permissionKind,
				g.scope ? encodeScope(g.scope) : null,
				g.decision,
				now,
				g.denyReason,
				workspaceRoot
			);
		}
		getDb()
			.prepare(
				`INSERT INTO workspace_permission_state(user_id, workspace_root, snapshot_text, content_hash, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, workspace_root) DO UPDATE SET
				   snapshot_text = excluded.snapshot_text,
				   content_hash = excluded.content_hash,
				   updated_at = excluded.updated_at`
			)
			.run(userId, workspaceRoot, snapshotText, contentHash, now);
	})();
	return grants.length;
}

/**
 * Delete a single grant by rowid. Scoped to `userId` so users can only
 * revoke their own. Returns true iff a row was removed.
 */
export function revokeGrant(userId: number, id: number): boolean {
	// Same ownership rule as `updateGrant`: a single workspace-file row is not
	// individually revocable — the whole `.zap/permissions.toml` snapshot is
	// (deletion of the file, or a re-approval). Refusing the row keeps the
	// approval state and the materialized rows consistent.
	const r = getDb()
		.prepare(
			`DELETE FROM permission_grants WHERE rowid = ? AND user_id = ? AND COALESCE(source, '') <> 'workspace-file'`
		)
		.run(id, userId);
	return r.changes > 0;
}

/**
 * Delete every grant owned by `userId`. Returns the number of rows removed.
 * Used by the settings page "Revoke all" action. This does NOT come back on
 * its own: `ensureSeedGrantsForUser` runs on user creation, not on login, so
 * the defaults return only via the "Restore default seed grants" action
 * (`restoreSeedGrantsForUser`). See the rollout note in `permissions/seed-grants.ts`.
 */
export function revokeAllGrantsForUser(userId: number): number {
	// Also drop the workspace-file approval state: without this, revoking all
	// would silently remove the materialized file grants while the gate still
	// believed the last approved snapshot was live — the file would never
	// re-gate on the next request.
	getDb().prepare(`DELETE FROM workspace_permission_state WHERE user_id = ?`).run(userId);
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
