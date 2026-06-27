// Pure helpers for the permission-grant matcher. SQL lives in the
// settings repo; this module only knows about pattern shapes and
// precedence rules so it can be exercised by unit tests without a DB.
//
// Two grant shapes coexist:
//   * Legacy (`scopePattern`)   — substring glob over the derived scope-key.
//   * Structured (`scope`)      — typed predicate per permission kind
//                                 (shell argv, fs containment, url host).
// When both are present on a row, structured wins; we never glob over a
// row that has a typed shape.

export { deriveScopeKey } from '../../permissions/scope-key';

import type { GrantScope } from '../../permissions/scope-types';
import type { ParsedSegment } from './shell-parser';
import { shellRuleMatches, shellRuleMatchesSegment } from './predicates/shell';
import { fsScopeMatches } from './predicates/fs';
import { urlScopeMatches } from './predicates/url';

export type GrantDecision = 'allow' | 'force-allow' | 'deny' | 'prompt';
export type MatchOutcome = 'allow' | 'deny' | 'prompt' | 'none';

export interface DetailedMatchOutcome {
	outcome: MatchOutcome;
	/** Agent-facing feedback from the matched deny or prompt-required grant. */
	feedback: string | null;
	/** @deprecated use `feedback`. */
	denyReason: string | null;
}

export interface GrantRow {
	tool: string;
	permissionKind: string | null;
	scopePattern: string | null;
	/** Structured grant. When set, the legacy `scopePattern` is ignored
	 * for this row. NULL on legacy rows. */
	scope: GrantScope | null;
	decision: GrantDecision;
	expiresAt: number | null;
	argsHash: string | null;
	/** Optional feedback for deny grants and prompt-required auto-rejects —
	 * surfaced to the agent via the SDK's `PermissionDecisionReject.feedback`
	 * field. Ignored on allow rows. NULL means no custom feedback. */
	denyReason: string | null;
	/**
	 * NULL = user-global grant. Used by callers that mix conversation-scoped
	 * and user-global rows; matchGrants does not itself filter on this.
	 */
	conversationId: string | null;
}

export interface MatchQuery {
	tool: string;
	permissionKind: string;
	/** Legacy scope-key (string). NULL when the caller couldn't derive
	 * one; only wildcard legacy grants will match. */
	scopeKey: string | null;
	/** Parsed shell command for structured shell grants. Omitted for
	 * non-shell requests or when the parser rejected the command. */
	shellSegments?: ParsedSegment[] | null;
	/** Target path for fs requests (`read` / `write` / `edit`). */
	target?: string | null;
	/** Target URL for `url` requests. */
	url?: string | null;
	/** Conversation's working directory, used by structured predicates
	 * that constrain to the workspace. */
	workspaceRoot?: string | null;
	/** SDK session workspace directory, used by session-workspace predicates. */
	sessionWorkspaceRoot?: string | null;
	/** Unix ms. Grants with `expiresAt < now` are ignored. */
	now: number;
	/** Canonical SHA-256 of the requested tool args. */
	argsHash?: string | null;
}

/**
 * Decide allow / deny / prompt / none against an in-memory list of candidate
 * grants. Precedence:
 *
 *   1. Matching `force-allow` grants approve the request even when deny grants match.
 *   2. Any matching `deny` grant wins as a hard block.
 *   3. Otherwise any matching `allow` grant wins.
 *   4. Otherwise any matching `prompt` grant forces a human prompt.
 *   5. Otherwise `none` — caller falls back to policy.
 *
 * "Match" means tool matches (exact or wildcard `*`), permission_kind
 * matches (exact, NULL = any, or `*`), and the scope pattern matches
 * the supplied scopeKey (NULL pattern = any, glob with `*` otherwise).
 * Expired grants are skipped.
 *
 * For shell requests with multiple parsed segments (e.g. `cd ./src &&
 * git diff`), hard-denies are checked first across all segments. Otherwise,
 * each segment is evaluated independently against the ordered grant set. This
 * lets a `cd` grant cover the prefix while a `git` grant covers the tail
 * without requiring a single rule that knows about both.
 */
export function matchGrants(rows: GrantRow[], q: MatchQuery): MatchOutcome {
	return matchGrantsDetailed(rows, q).outcome;
}

/**
 * Like `matchGrants`, but additionally returns agent-facing feedback from
 * the matched hard-deny or prompt-required grant. Grants are evaluated in
 * precedence order (force-allow, deny, allow, prompt), preserving input order
 * within each tier.
 */
export function matchGrantsDetailed(rows: GrantRow[], q: MatchQuery): DetailedMatchOutcome {
	const orderedRows = sortGrantRows(rows);
	const forceAllow = matchFirst(orderedRows, q, (r) => r.decision === 'force-allow');
	if (forceAllow) return withFeedback('allow', null);
	const hardDeny = matchHardDeny(orderedRows, q);
	if (hardDeny) return hardDeny;
	if (q.permissionKind === 'shell' && q.shellSegments && q.shellSegments.length > 0) {
		return matchShellSegments(orderedRows, q, q.shellSegments);
	}
	const match = matchFirst(orderedRows, q, (r) => !r.argsHash);
	if (!match) return withFeedback('none', null);
	return withFeedback(
		match.decision === 'force-allow' ? 'allow' : match.decision,
		match.decision === 'allow' || match.decision === 'force-allow' ? null : match.denyReason
	);
}

function matchHardDeny(rows: GrantRow[], q: MatchQuery): DetailedMatchOutcome | null {
	if (q.permissionKind === 'shell' && q.shellSegments && q.shellSegments.length > 0) {
		for (let i = 0; i < q.shellSegments.length; i++) {
			const seg = q.shellSegments[i];
			const ctx = {
				workspaceRoot: q.workspaceRoot ?? null,
				sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null,
				inPipeline: segmentInPipeline(q.shellSegments, i)
			};
			for (const r of rows) {
				if (r.decision !== 'deny') continue;
				if (!grantApplies(r, q)) continue;
				if (!rowMatchesShellSegment(r, seg, q, ctx)) continue;
				return withFeedback('deny', r.denyReason);
			}
		}
		return null;
	}
	for (const r of rows) {
		if (r.decision !== 'deny') continue;
		if (!grantApplies(r, q)) continue;
		if (!rowScopeMatches(r, q)) continue;
		return withFeedback('deny', r.denyReason);
	}
	return null;
}

function matchFirst(
	rows: GrantRow[],
	q: MatchQuery,
	filter: (r: GrantRow) => boolean
): GrantRow | null {
	for (const r of rows) {
		if (!filter(r)) continue;
		if (!grantApplies(r, q)) continue;
		if (!rowScopeMatches(r, q)) continue;
		return r;
	}
	return null;
}

function matchShellSegments(
	rows: GrantRow[],
	q: MatchQuery,
	segments: ParsedSegment[]
): DetailedMatchOutcome {
	let allAllowed = true;
	let sawPrompt = false;
	let promptFeedback: string | null = null;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const inPipeline = segmentInPipeline(segments, i);
		const ctx = {
			workspaceRoot: q.workspaceRoot ?? null,
			sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null,
			inPipeline
		};
		let segMatched = false;
		for (const r of rows) {
			if (r.decision === 'deny') continue;
			if (r.decision === 'force-allow') continue;
			if (r.argsHash) continue;
			if (!grantApplies(r, q)) continue;
			if (!rowMatchesShellSegment(r, seg, q, ctx)) continue;
			segMatched = true;
			if (r.decision === 'prompt') {
				sawPrompt = true;
				promptFeedback ??= r.denyReason;
			}
			break;
		}
		if (!segMatched || sawPrompt) allAllowed = false;
	}
	if (sawPrompt) return withFeedback('prompt', promptFeedback);
	return withFeedback(allAllowed ? 'allow' : 'none', null);
}

function sortGrantRows(rows: GrantRow[]): GrantRow[] {
	return [...rows].sort((a, b) => grantRank(a) - grantRank(b));
}

function grantRank(r: GrantRow): number {
	if (r.decision === 'force-allow') return 0;
	if (r.decision === 'deny') return 1;
	if (r.decision === 'allow') return 2;
	return 3;
}

function withFeedback(outcome: MatchOutcome, feedback: string | null): DetailedMatchOutcome {
	return { outcome, feedback, denyReason: feedback };
}

/**
 * A segment is "in a pipeline" iff it's connected to a neighbor by `|`
 * — either it's followed by `|`, or the previous segment was followed
 * by `|`. Used by the structured shell predicate to enforce
 * `pipeline: 'must' | 'forbid'` on a ShellRule.
 */
function segmentInPipeline(segments: ParsedSegment[], i: number): boolean {
	if (segments[i].followingOp === '|') return true;
	if (i > 0 && segments[i - 1].followingOp === '|') return true;
	return false;
}

function grantApplies(r: GrantRow, q: MatchQuery): boolean {
	if (r.expiresAt !== null && r.expiresAt < q.now) return false;
	if (!toolMatches(r.tool, q.tool)) return false;
	if (!kindMatches(r.permissionKind, q.permissionKind)) return false;
	if (r.argsHash && r.argsHash !== q.argsHash) return false;
	return true;
}

function rowMatchesShellSegment(
	r: GrantRow,
	seg: ParsedSegment,
	q: MatchQuery,
	ctx: {
		workspaceRoot: string | null;
		sessionWorkspaceRoot: string | null;
		inPipeline: boolean;
	}
): boolean {
	if (r.scope) {
		switch (r.scope.kind) {
			case 'any':
				return true;
			case 'shell':
				return shellRuleMatchesSegment(r.scope.rule, seg, ctx);
			default:
				return false;
		}
	}
	return scopeMatches(r.scopePattern, seg.argv.join(' '));
}

function rowScopeMatches(r: GrantRow, q: MatchQuery): boolean {
	if (r.scope) return structuredScopeMatches(r.scope, q);
	return scopeMatches(r.scopePattern, q.scopeKey);
}

function structuredScopeMatches(scope: GrantScope, q: MatchQuery): boolean {
	switch (scope.kind) {
		case 'any':
			return true;
		case 'shell':
			if (q.permissionKind !== 'shell') return false;
			if (!q.shellSegments) return false;
			return shellRuleMatches(scope.rule, q.shellSegments, {
				workspaceRoot: q.workspaceRoot ?? null,
				sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null
			});
		case 'fs': {
			const kind = q.permissionKind;
			if (kind !== 'read' && kind !== 'write' && kind !== 'edit') return false;
			if (!q.target) return false;
			return fsScopeMatches(scope, {
				permissionKind: kind,
				target: q.target,
				workspaceRoot: q.workspaceRoot ?? null,
				sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null
			});
		}
		case 'url':
			if (q.permissionKind !== 'url') return false;
			if (!q.url) return false;
			return urlScopeMatches(scope, { url: q.url });
		default: {
			const _exhaustive: never = scope;
			void _exhaustive;
			return false;
		}
	}
}

function toolMatches(grant: string, want: string): boolean {
	return grant === '*' || grant === want;
}

function kindMatches(grant: string | null, want: string): boolean {
	if (grant === null || grant === '*') return true;
	return grant === want;
}

function scopeMatches(pattern: string | null, scopeKey: string | null): boolean {
	if (pattern === null || pattern === '' || pattern === '*') return true;
	if (scopeKey === null) return false;
	return globToRegex(pattern).test(scopeKey);
}

const GLOB_CACHE = new Map<string, RegExp>();
const GLOB_CACHE_MAX = 512;

/**
 * Tiny glob → RegExp. `*` matches any run of characters (including
 * empty, including `/`); everything else is a literal. We deliberately
 * keep it minimal — the scope vocabulary is shell commands, file paths,
 * and URLs, and users want simple "starts with" patterns like
 * `git status*`, `./src/*`, `https://api.github.com/*`. A richer
 * minimatch-style grammar can come later if there's demand.
 *
 * The cache is bounded to `GLOB_CACHE_MAX` entries with LRU eviction so
 * that arbitrary `scopePattern` strings (e.g. from the grants table)
 * can't grow it without bound. `Map` preserves insertion order, so the
 * first key is the least-recently-used entry.
 */
export function globToRegex(pattern: string): RegExp {
	const cached = GLOB_CACHE.get(pattern);
	if (cached) {
		GLOB_CACHE.delete(pattern);
		GLOB_CACHE.set(pattern, cached);
		return cached;
	}
	let re = '^';
	for (const ch of pattern) {
		if (ch === '*') re += '.*';
		else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	}
	re += '$';
	const r = new RegExp(re);
	if (GLOB_CACHE.size >= GLOB_CACHE_MAX) {
		const oldest = GLOB_CACHE.keys().next().value;
		if (oldest !== undefined) GLOB_CACHE.delete(oldest);
	}
	GLOB_CACHE.set(pattern, r);
	return r;
}

/**
 * Derive a scope key from the SDK's permission-request payload. Returns
 * null if no meaningful scope can be extracted; the matcher will then
 * only fire for wildcard-pattern grants.
 *
 * @deprecated Re-exported from `$lib/permissions/scope-key` so the dialog
 * can use the same logic without pulling in server-only modules. Server
 * code may import this name; new client code should import from
 * `$lib/permissions/scope-key`.
 */
export {};
