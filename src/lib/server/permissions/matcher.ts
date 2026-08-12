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

import type { GrantScope, FsPermission } from '../../permissions/scope-types';
import type { ParsedSegment } from './shell-parser';
import {
	shellRuleMatches,
	shellRuleMatchesSegment,
	type ShellMatchContext,
	type ShellMatchExplain
} from './predicates/shell';
import { fsScopeMatches } from './predicates/fs';
import { urlScopeMatches } from './predicates/url';
import { isAbsolute, resolve } from 'node:path';

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
	/** Every root the conversation may act inside — its own workspace plus any
	 * worktree leases it holds. Used by structured predicates that constrain to
	 * the workspace. */
	workspaceRoots?: readonly string[] | null;
	/** SDK session workspace directory, used by session-workspace predicates. */
	sessionWorkspaceRoot?: string | null;
	/**
	 * Directory that relative shell operands resolve against — the shell's cwd.
	 * Used only by the `readable-paths` / `writable-paths` positional kinds.
	 *
	 * NOT interchangeable with `sessionWorkspaceRoot`. That one is the SDK's
	 * long-lived session-state directory, which is a different place from the
	 * checkout shell commands actually run in.
	 * Resolving a relative operand against it would ask about a file the shell
	 * will never open — and could approve it, since that directory is readable
	 * under its own seed. Fails closed when absent.
	 */
	shellCwd?: string | null;
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
 * git diff`), each segment is evaluated independently against the ordered
 * grant set and the results are combined by taking the MOST RESTRICTIVE
 * outcome across segments: `deny` > `none` > `prompt` > `allow`. This lets a
 * `cd` grant cover the prefix while a `git` grant covers the tail without
 * requiring a single rule that knows about both — but it never lets a grant
 * covering one segment silently approve a sibling segment that no grant
 * covers. An uncovered segment yields `none` (fall through to policy) even
 * when another segment matched a `prompt`/`allow` grant, so the human dialog
 * can't be made to approve more than it describes. `force-allow` is applied
 * per segment and overrides a `deny` on that same segment (so a force-allow
 * created to bypass a deny still works when the command is chained), but it
 * only covers the segment(s) it actually matches.
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
	if (q.permissionKind === 'shell' && q.shellSegments && q.shellSegments.length > 0) {
		// Shell chains/pipelines are evaluated per segment, with force-allow,
		// deny, allow and prompt all resolved inside matchShellSegments so that
		// force-allow can override a deny on the same segment and an uncovered
		// segment can pull the whole chain down to `none`.
		return matchShellSegments(orderedRows, q, q.shellSegments);
	}
	const forceAllow = matchFirst(orderedRows, q, (r) => r.decision === 'force-allow');
	if (forceAllow) return withFeedback('allow', null);
	const hardDeny = matchHardDeny(orderedRows, q);
	if (hardDeny) return hardDeny;
	const match = matchFirst(orderedRows, q, (r) => !r.argsHash);
	if (!match) return withFeedback('none', null);
	return withFeedback(
		match.decision === 'force-allow' ? 'allow' : match.decision,
		match.decision === 'allow' || match.decision === 'force-allow' ? null : match.denyReason
	);
}

function matchHardDeny(rows: GrantRow[], q: MatchQuery): DetailedMatchOutcome | null {
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

/**
 * Resolve a shell request whose command parsed into one or more segments.
 *
 * Each segment is matched independently against the ordered grant set; the
 * first matching grant (rows are pre-sorted force-allow → deny → allow →
 * prompt) decides that segment's outcome. A force-allow that matches a
 * segment therefore overrides a deny on the SAME segment. Per-segment
 * outcomes are then combined by taking the most restrictive: an uncovered
 * segment is `none`, and the precedence is `deny` > `none` > `prompt` >
 * `allow`. Crucially, an uncovered segment is NOT swallowed by another
 * segment's `prompt`/`allow`: the chain falls through to `none` so the
 * generic policy prompt (with accurate feedback) covers it, instead of the
 * dialog for a benign segment silently approving the uncovered one.
 */
function matchShellSegments(
	rows: GrantRow[],
	q: MatchQuery,
	segments: ParsedSegment[]
): DetailedMatchOutcome {
	let sawDeny = false;
	let sawUncovered = false;
	let sawPrompt = false;
	let denyFeedback: string | null = null;
	let uncoveredFeedback: string | null = null;
	let promptFeedback: string | null = null;
	const pathPermittedFor = buildFsPathPermitted(rows, q);
	// A `cd` earlier in the chain moves the shell's working directory, so from
	// that point on a relative operand no longer means what the session cwd says
	// it means. Rather than model cwd (the target may itself be unresolvable), the
	// fs-deferred kinds stop accepting relative operands after such a segment.
	let cwdMoved = false;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const ctx = {
			workspaceRoots: q.workspaceRoots ?? null,
			sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null,
			pathPermitted: pathPermittedFor(!cwdMoved),
			inPipeline: segmentInPipeline(segments, i),
			isPipeTarget: segmentIsPipeTarget(segments, i)
		};
		if (movesWorkingDirectory(seg)) cwdMoved = true;
		let segDecision: GrantDecision | null = null;
		let segFeedback: string | null = null;
		let segNearMiss: string | null = null;
		for (const r of rows) {
			if (!grantApplies(r, q)) continue;
			// Only allow-shaped grants produce a near-miss explanation: a deny or
			// prompt row that fails to match is not a capability the request was
			// reaching for.
			const explain: ShellMatchExplain | undefined =
				r.decision === 'allow' || r.decision === 'force-allow' ? {} : undefined;
			if (!rowMatchesShellSegment(r, seg, ctx, explain)) {
				if (explain?.positionalRefusal && segNearMiss === null) {
					segNearMiss = explain.positionalRefusal;
				}
				continue;
			}
			segDecision = r.decision;
			segFeedback = r.denyReason;
			break;
		}
		if (segDecision === 'deny') {
			sawDeny = true;
			denyFeedback ??= segFeedback;
		} else if (segDecision === null) {
			sawUncovered = true;
			// Attribution matters: the near-miss is only reported alongside the
			// outcome of the SAME segment, so a chain can't explain one segment's
			// refusal with another segment's reason.
			uncoveredFeedback ??= segNearMiss;
		} else if (segDecision === 'prompt') {
			sawPrompt = true;
			promptFeedback ??= combineFeedback(segFeedback, segNearMiss);
		}
		// 'allow' / 'force-allow' contribute the least-restrictive outcome and
		// need no bookkeeping.
	}
	if (sawDeny) return withFeedback('deny', denyFeedback);
	// An uncovered chain carries no grant feedback, but it may carry the reason
	// an fs-deferring allow grant declined it — which is what stops the caller
	// from reporting a workspace-boundary problem for a missing fs permission.
	if (sawUncovered) return withFeedback('none', uncoveredFeedback);
	if (sawPrompt) return withFeedback('prompt', promptFeedback);
	return withFeedback('allow', null);
}

/** Builtins that relocate the shell for every segment that follows them. */
const CWD_MOVING_BUILTINS = new Set(['cd', 'pushd', 'popd', 'chdir']);

function movesWorkingDirectory(seg: ParsedSegment): boolean {
	return CWD_MOVING_BUILTINS.has(seg.argv[0]);
}

/** Keep a matched grant's own steer, but append the more specific near-miss. */
function combineFeedback(feedback: string | null, nearMiss: string | null): string | null {
	if (!feedback) return nearMiss;
	if (!nearMiss) return feedback;
	return `${feedback} (${nearMiss})`;
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

/**
 * Upper bound on distinct (permission, path) questions one request may ask the
 * fs grant set. Each question costs a grant scan plus a realpath, and a normal
 * command has a handful of positionals — a command with more than this is
 * pathological, so it fails closed (→ prompt) rather than being allowed to burn
 * time in the permission hot path. Repeated questions are memoized and don't
 * count against the budget.
 */
const MAX_FS_DEFERRED_CHECKS = 64;

/**
 * Build the `pathPermitted` closures the shell predicate uses for
 * `readable-paths` / `writable-paths`, from the SAME candidate grant rows the
 * shell request is being matched against. The nested question is answered by
 * re-entering `matchGrantsDetailed` as a plain fs request, so fs precedence
 * (force-allow > deny > allow > prompt) is shared rather than reimplemented:
 * only an `allow` outcome satisfies the shell rule, which is exactly the
 * "an fs prompt/deny does not satisfy a shell allow" semantics documented on
 * `PositionalsRule`.
 *
 * Returns a factory taking `allowRelative`, because a segment that runs after a
 * `cd` no longer sits in the cwd we know about; the memo cache and the budget
 * are shared across both modes.
 *
 * Recursion is impossible by construction, not by luck: shell-scoped rows are
 * filtered out and the nested query carries no `shellSegments`, so the nested
 * call cannot re-enter shell matching (and therefore cannot build another
 * closure).
 */
function buildFsPathPermitted(
	rows: GrantRow[],
	q: MatchQuery
): (allowRelative: boolean) => (perm: FsPermission, path: string) => boolean {
	// Built lazily: most shell requests never reach a grant-deferring positional
	// rule, and this is the permission hot path.
	let fsRows: GrantRow[] | null = null;
	const cache = new Map<string, boolean>();
	let checks = 0;
	const permitted = (allowRelative: boolean, perm: FsPermission, rawPath: string): boolean => {
		const key = `${allowRelative ? 'r' : 'a'}\u0000${perm}\u0000${rawPath}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		if (checks >= MAX_FS_DEFERRED_CHECKS) return false;
		checks += 1;
		fsRows ??= rows.filter((r) => r.scope?.kind !== 'shell');
		const target = absolutePositional(rawPath, allowRelative ? (q.shellCwd ?? null) : null);
		const ok =
			target !== null &&
			matchGrantsDetailed(fsRows, {
				tool: perm,
				permissionKind: perm,
				// fs requests carry the target path as their scope key. Note the
				// nested key is always ABSOLUTE while a real fs request may pass a
				// relative one, so a legacy `scope_pattern` grant written against
				// relative paths simply doesn't fire here — a narrowing, which is
				// the safe direction for a fail-closed check.
				scopeKey: target,
				target,
				workspaceRoots: q.workspaceRoots ?? null,
				sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null,
				now: q.now
			}).outcome === 'allow';
		cache.set(key, ok);
		return ok;
	};
	return (allowRelative) => (perm, rawPath) => permitted(allowRelative, perm, rawPath);
}

/**
 * Resolve a positional as written on the command line to an absolute path.
 * Relative operands are resolved against the shell's working directory (the
 * SDK session workspace); when that is unknown — or when an earlier `cd` in the
 * chain means we no longer know where the command runs — they fail closed,
 * because a relative path has no meaning to compare against an absolute fs rule.
 */
function absolutePositional(rawPath: string, cwd: string | null): string | null {
	if (!rawPath || rawPath.includes('\0')) return null;
	if (isAbsolute(rawPath)) return resolve(rawPath);
	if (!cwd || cwd.includes('\0')) return null;
	return resolve(cwd, rawPath);
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

/**
 * A segment is a "pipe target" iff it consumes a predecessor's stdout —
 * the previous segment was followed by `|`. Narrower than
 * `segmentInPipeline`, which is also true for the producer side. Used by
 * `pipeline: 'pipe-target'` to allow a command only as a filter over
 * piped input.
 */
function segmentIsPipeTarget(segments: ParsedSegment[], i: number): boolean {
	return i > 0 && segments[i - 1].followingOp === '|';
}

function grantApplies(r: GrantRow, q: MatchQuery): boolean {
	if (r.expiresAt !== null && r.expiresAt < q.now) return false;
	if (!toolMatches(r.tool, q.tool, q.permissionKind)) return false;
	if (!kindMatches(r.permissionKind, q.permissionKind)) return false;
	if (r.argsHash && r.argsHash !== q.argsHash) return false;
	return true;
}

function rowMatchesShellSegment(
	r: GrantRow,
	seg: ParsedSegment,
	ctx: ShellMatchContext,
	explain?: ShellMatchExplain
): boolean {
	if (r.scope) {
		switch (r.scope.kind) {
			case 'any':
				return true;
			case 'shell':
				return shellRuleMatchesSegment(r.scope.rule, seg, ctx, explain);
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
			// Reachable only for an empty segment list (non-empty lists are routed
			// to `matchShellSegments`, which supplies `pathPermitted`), so the
			// fs-deferring positional kinds correctly fail closed here.
			return shellRuleMatches(scope.rule, q.shellSegments, {
				workspaceRoots: q.workspaceRoots ?? null,
				sessionWorkspaceRoot: q.sessionWorkspaceRoot ?? null
			});
		case 'fs': {
			const kind = q.permissionKind;
			if (kind !== 'read' && kind !== 'write' && kind !== 'edit') return false;
			if (!q.target) return false;
			return fsScopeMatches(scope, {
				permissionKind: kind,
				target: q.target,
				workspaceRoots: q.workspaceRoots ?? null,
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

function toolMatches(grant: string, wantTool: string, wantKind: string): boolean {
	// A grant row is keyed either by the tool's own name (rows persisted from a
	// permission prompt, e.g. `Bash` or `web_fetch`) or by the canonical
	// permission vocabulary used by the seeds and the settings form
	// (`shell`/`read`/`write`/`edit`/`url`). Accept either so a saved grant
	// matches an SDK built-in request whose tool name differs from its kind
	// (`Bash` → kind `shell`); the `kindMatches` check below still constrains
	// which rows actually apply.
	return grant === '*' || grant === wantTool || grant === wantKind;
}

function kindMatches(grant: string | null, want: string): boolean {
	if (grant === null || grant === '*') return true;
	return grant === want;
}

function scopeMatches(pattern: string | null, scopeKey: string | null): boolean {
	if (pattern === null || pattern === '' || pattern === '*') return true;
	if (scopeKey === null) return false;
	return globMatches(pattern, scopeKey);
}

/**
 * Tiny glob matcher. `*` matches any run of characters (including
 * empty, including `/` and spaces); every other character is a literal.
 * We deliberately keep it minimal — the scope vocabulary is shell
 * commands, file paths, and URLs, and users want simple "starts with"
 * patterns like `git status*`, `./src/*`, `https://api.github.com/*`.
 *
 * `*` intentionally crosses `/` (unlike the fs predicate's segment-scoped
 * `[^/]*`): for shell command and URL scope-keys, `/` is an ordinary
 * character that patterns must be able to span — e.g. the seeded hard-deny
 * grants `git -C *` / `git * --git-dir=*` must match `git -C /tmp status`.
 *
 * Implemented as a linear-time two-pointer scan with a single backtrack
 * pointer per `*` (the classic wildcard-match algorithm), NOT by compiling
 * to a backtracking `RegExp`. Patterns are user-controllable (the grants
 * table), so a regex translation of `*` → `.*` would be a ReDoS sink: a
 * pattern like `*a*a*a…*x` against a long non-matching key triggers
 * catastrophic backtracking in V8's Irregexp and stalls the event loop on
 * every permission check. This scan is worst-case O(pattern × key) with no
 * exponential blow-up, so no compiled-regex cache is needed.
 */
export function globMatches(pattern: string, value: string): boolean {
	let p = 0;
	let s = 0;
	let starP = -1;
	let starS = 0;
	while (s < value.length) {
		if (p < pattern.length && pattern[p] === '*') {
			// Record the wildcard position and the point in `value` to resume
			// from, then tentatively let `*` match zero characters.
			starP = p;
			starS = s;
			p++;
		} else if (p < pattern.length && pattern[p] === value[s]) {
			p++;
			s++;
		} else if (starP !== -1) {
			// Mismatch after a `*`: backtrack and let that `*` consume one
			// more character of `value`.
			p = starP + 1;
			starS++;
			s = starS;
		} else {
			return false;
		}
	}
	// Trailing `*`s in the pattern match the empty remainder.
	while (p < pattern.length && pattern[p] === '*') p++;
	return p === pattern.length;
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
