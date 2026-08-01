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
 * Asymmetry to watch for: the "allow all except" fall-through only applies
 * to the final step's options (which interleave with positionals). On a
 * non-final (intermediate) step, options are matched while scanning toward
 * the next command-path token, so a token there must satisfy the allow-list
 * to be accepted — a deny-only rule on an intermediate step rejects every
 * option rather than permitting the un-denied ones.
 *
 * Omitting both (an absent `options`) permits no options at all on that
 * step — the matcher treats any option token as unrecognised and rejects.
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
	 * allowed.
	 *   none             — every positional must be absent
	 *   any              — anything goes
	 *   pattern-only     — at most ONE positional, treated as an opaque
	 *                      non-path operand (a search pattern). Any further
	 *                      positional is rejected. This is the rule for
	 *                      stdin filters like `grep`/`rg`, whose first
	 *                      positional is a regex — never a path — and whose
	 *                      later positionals are the file operands we do not
	 *                      want to auto-approve. Path-shaped rules are wrong
	 *                      for them in both directions: a regex is not a path
	 *                      to be containment-checked, and a file operand must
	 *                      not slip through as one.
	 *   workspace-paths          — every positional must resolve to a path
	 *                              inside the conversation's workspace root
	 *   session-workspace-paths  — every positional must resolve to a path
	 *                              inside the SDK session workspace
	 */
	positionals?: PositionalsRule | undefined;
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

export type PositionalsRule =
	| { kind: 'none' }
	| { kind: 'any' }
	| { kind: 'pattern-only' }
	| { kind: 'workspace-paths' }
	| { kind: 'session-workspace-paths' };

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
