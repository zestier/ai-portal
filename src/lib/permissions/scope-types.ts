// Structured permission grant scopes.
//
// A grant row stores `scope_json` describing what the grant covers.
// Legacy v2 rows store the old `scope_pattern` (substring glob over the
// derived scope-key) and have `scope_json = NULL`; new writes only emit
// scope_json. The matcher dispatches on the structured shape per
// permission kind.
//
// Shapes are intentionally narrow: each rule has a small fixed set of
// constraints, no free-form regex/glob over command strings. Adding a
// new lever is a typed change with predicate + UI + tests, not a string
// the user has to author.

export type GrantScope = ShellScope | FsScope | UrlScope | AnyScope;

/** Matches `shell` permission requests. */
export interface ShellScope {
	kind: 'shell';
	rule: ShellRule;
}

/**
 * Option constraints for one command-path step.
 *
 * The two lists combine into three meaningfully different shapes — be
 * deliberate about which one you author, because the open-allow case is
 * easy to reach by accident:
 *
 *   allow only         — allow-list: an option token is permitted only if
 *                        it matches a spec; everything else is rejected.
 *   allow + deny       — deny wins. A token matching `deny` is rejected
 *                        even if it also matches `allow`.
 *   deny only          — DENY-LIST ("allow all except"): on the FINAL
 *                        command step, every option NOT on the deny list
 *                        falls through and is permitted. This is intentional
 *                        for broad read-only tools like `rg` / `find` where
 *                        enumerating every safe flag is impractical, but it
 *                        means a newly-added exec-capable flag is auto-approved
 *                        until the deny list is updated. Prefer an allow-list
 *                        when you can enumerate the safe options; reach for
 *                        deny-only only when you knowingly want "everything
 *                        except these".
 *
 * Deny entries are matched by `matchesDeniedOption` (see the predicate) as the
 * exact token, `name=value`, any unambiguous `--` ABBREVIATION of a long name
 * (`--out` denies for `--output`, because `getopt_long` accepts it), or — for a
 * single-dash single-character name — that letter ANYWHERE in a getopt cluster,
 * so `-o` also denies `-bo/tmp/x`. What is NOT derived is the other spelling of
 * the same option: `-fprint` does not cover `-fprint0`, and `-o` does not cover
 * `--output`. Enumerate every spelling you mean to deny.
 *
 * Note also that deny lists constrain option TOKENS, never option VALUES: a
 * path passed as an option value is invisible to `positionals`, so an option
 * that names a file it reads or writes has to be denied outright.
 *
 * Asymmetry to watch for: the "allow all except" fall-through only applies
 * to the final step's options (which interleave with positionals). On a
 * non-final (intermediate) step, options are matched while scanning toward
 * the next command-path token, so a token there must satisfy the allow-list
 * to be accepted — a deny-only rule on an intermediate step rejects every
 * option rather than permitting the un-denied ones.
 *
 * Omitting both (an absent `options`) follows the same asymmetry: on an
 * INTERMEDIATE step it permits no options at all (any option token before the
 * next command-path token is unrecognised and rejects), while on the FINAL step
 * it is the widest deny-only case — an empty deny list — so every option token
 * falls through as permitted. That is what lets `{ token: 'ls' }` cover
 * `ls -la`, and it is why a final-step rule's safety rests entirely on its
 * positionals plus whatever it denies.
 */
export interface ShellOptionRules {
	allow?: ShellOptionSpec[] | undefined;
	deny?: string[] | undefined;
}

export type ShellOptionSpec =
	| { name: string; kind: 'flag' }
	| { name: string; kind: 'option'; value: ShellOptionValueRule };

export type ShellOptionValueRule = { kind: 'any' } | { kind: 'workspace-path' };

export interface ShellCommandStep {
	token: string;
	options?: ShellOptionRules | undefined;
}

export interface ShellRule {
	/**
	 * Ordered command path. The first step matches argv[0]; subsequent steps
	 * match subcommand tokens. Each step owns the options allowed after that
	 * token and before the next command-path token. Options on the final step
	 * may be interleaved with positional arguments.
	 */
	command: ShellCommandStep[];
	/**
	 * What positional arguments (non-flag tokens other than argv[0], the
	 * command-path tokens, and values consumed by matched option specs) are
	 * allowed. This constrains the SHAPE of each positional; use
	 * `positionalCount` to constrain how many there are.
	 *   none             — every positional must be absent
	 *   any              — anything goes; positionals are opaque and are NOT
	 *                      resolved or containment-checked. Correct for
	 *                      operands that aren't paths at all, such as a
	 *                      `grep` pattern
	 *   workspace-paths          — every positional must resolve to a path
	 *                              inside the conversation's workspace root
	 *   session-workspace-paths  — every positional must resolve to a path
	 *                              inside the SDK session workspace
	 *   readable-paths           — every positional must be a path the user's
	 *                              `read` grants already permit
	 *   writable-paths           — same, for `write`
	 *
	 * See `PositionalsRule` for the precedence and fail-closed semantics of
	 * the two grant-deferring kinds.
	 */
	positionals?: PositionalsRule | undefined;
	/**
	 * Inclusive bounds on the NUMBER of positionals, orthogonal to the
	 * containment rule above; omitted bounds are unconstrained. Composing
	 * the two is what makes narrow rules expressible without inventing a
	 * named variant per command shape:
	 *
	 *   `grep` as a pure stdin filter  — positionals `any` + max 1 (the lone
	 *     operand is the pattern; a second one is a file to read, which the
	 *     rule refuses)
	 *   a single-file reader           — `workspace-paths` + min 1, max 1
	 *
	 * Note `{ kind: 'none' }` is equivalent to max 0 and is kept as the
	 * clearer spelling of that case.
	 */
	positionalCount?: PositionalCountRule | undefined;
	/**
	 * Whether this segment must / must not be part of a shell pipeline
	 * (i.e. connected to a neighboring command by `|`). Omitted = no
	 * constraint. Used by the seed prompt grants for commands like `cat`
	 * / `grep` whose stdout is the human-visible output when run bare,
	 * but which are legitimate inside `cmd | grep ...`.
	 *   must         — this segment must be in a pipeline (either side of a `|`)
	 *   forbid       — this segment must NOT be in a pipeline
	 *   pipe-target  — this segment must be DOWNSTREAM of a `|`, i.e. it
	 *                  consumes another command's stdout. Strictly narrower
	 *                  than `must`, which also matches the producer: in
	 *                  `grep x file | head`, grep satisfies `must` while
	 *                  still reading files off disk. `pipe-target` is how a
	 *                  grant says "only as a filter over piped input".
	 */
	pipeline?: 'must' | 'forbid' | 'pipe-target' | undefined;
}

/**
 * How a shell rule constrains a command's positional (non-option) operands.
 *
 * `workspace-paths` / `session-workspace-paths` describe containment in a
 * hardcoded root. `readable-paths` / `writable-paths` instead DEFER to the
 * user's filesystem grants, so a shell reader covers exactly the paths the
 * `view` tool may read (or `create`/`edit` may write) without the user
 * mirroring every fs rule into every shell grant.
 *
 * Semantics of the two deferring kinds:
 *
 *   * A positional is satisfied only when the fs grant set resolves that path
 *     to an ALLOW (`allow` / `force-allow`). An fs `prompt` grant does NOT
 *     silently satisfy a shell allow.
 *   * An fs `deny` on the path does NOT turn the shell request into a deny —
 *     it merely leaves this shell rule unmatched, so the request falls through
 *     to the other shell grants and to policy. Shell-level denies stay owned by
 *     the shell deny seeds, which is what makes their feedback accurate.
 *   * Evaluation FAILS CLOSED. With no way to consult the fs grants
 *     (`ShellMatchContext.pathPermitted` absent), the rule matches nothing —
 *     the same posture `workspace-paths` takes when `workspaceRoots` is empty.
 *   * Relative positionals are resolved against the shell's working directory
 *     (the SDK session workspace); when that is unknown — or when an earlier
 *     `cd` in the same chain moved the shell somewhere we don't model — a
 *     relative positional fails closed.
 *   * Zero positionals trivially satisfy the rule, matching the other
 *     path-shaped kinds.
 *   * Only POSITIONALS are checked. A path passed as an option value (`-f
 *     /etc/shadow`) is governed by that step's `ShellOptionRules`, so a rule
 *     that grants an open deny-list of options is not made safe by this kind.
 */
export type PositionalsRule =
	| { kind: 'none' }
	| { kind: 'any' }
	| { kind: 'workspace-paths' }
	| { kind: 'session-workspace-paths' }
	| { kind: 'readable-paths' }
	| { kind: 'writable-paths' };

/**
 * The `PositionalsRule` kinds that defer containment to the fs grants, mapped
 * to the fs permission each one asks about. Shared by the schema, codec,
 * predicate and UI so a new kind can't be added in one place and forgotten in
 * another.
 */
export const FS_DEFERRED_POSITIONALS_KINDS = {
	'readable-paths': 'read',
	'writable-paths': 'write'
} as const satisfies Record<string, FsPermission>;

export type FsDeferredPositionalsKind = keyof typeof FS_DEFERRED_POSITIONALS_KINDS;

/**
 * Every `PositionalsRule` kind, in the order the grant form offers them.
 * The two assertions below make this list the single source of truth: adding
 * a variant to `PositionalsRule` without listing it here is a type error, and
 * listing a kind that isn't a variant is too.
 */
export const POSITIONALS_KINDS = [
	'none',
	'any',
	'workspace-paths',
	'session-workspace-paths',
	'readable-paths',
	'writable-paths'
] as const satisfies readonly PositionalsRule['kind'][];

type _PositionalsKindsAreExhaustive =
	PositionalsRule['kind'] extends (typeof POSITIONALS_KINDS)[number] ? true : never;
const _positionalsKindsAreExhaustive: _PositionalsKindsAreExhaustive = true;
void _positionalsKindsAreExhaustive;

/** Inclusive positional-count bounds. Both ends are optional and each is a
 * non-negative integer; `min` must not exceed `max`. */
export interface PositionalCountRule {
	min?: number | undefined;
	max?: number | undefined;
}

/** Matches `read` / `write` / `edit` permission requests. */
export interface FsScope {
	kind: 'fs';
	/** Which kinds this grant covers. Empty = all three. */
	perms?: FsPermission[] | undefined;
	rule: FsRule;
}

export const FS_PERMISSIONS = ['read', 'write', 'edit'] as const;
export type FsPermission = (typeof FS_PERMISSIONS)[number];

export const FS_RULE_ROOTS = ['workspace', 'session-workspace', 'absolute'] as const;
export type FsRuleRoot = (typeof FS_RULE_ROOTS)[number];

export const FS_RULE_CONTAINER_ROOTS = ['workspace', 'session-workspace'] as const;
export type FsRuleContainerRoot = (typeof FS_RULE_CONTAINER_ROOTS)[number];

export const FS_RULE_BEHAVIORS_WITH_VALUE = ['exact', 'prefix', 'glob'] as const;
export type FsRuleBehaviorWithValue = (typeof FS_RULE_BEHAVIORS_WITH_VALUE)[number];

export type FsRule =
	/**
	 * Composable path rule. `root` chooses the coordinate system, `behavior`
	 * chooses the matcher, and `value` is required for exact / prefix / glob.
	 *
	 *   workspace / session-workspace — value is relative to that root
	 *   absolute                      — value is an absolute path or glob
	 */
	| { kind: 'path'; root: FsRuleContainerRoot; behavior: 'any' }
	| { kind: 'path'; root: FsRuleRoot; behavior: FsRuleBehaviorWithValue; value: string };

/** Matches `url` permission requests. */
export interface UrlScope {
	kind: 'url';
	rule: UrlRule;
}

export type UrlRule =
	| { kind: 'exact'; url: string }
	| { kind: 'host'; host: string }
	/** Match host iff it equals `suffix` or ends with `'.' + suffix`. */
	| { kind: 'host-suffix'; suffix: string };

/** Catch-all for v2-era rows we migrate without conversion ("Allow always"
 * with no kind/pattern). The matcher treats this as "any request for the
 * grant's tool". */
export interface AnyScope {
	kind: 'any';
}
