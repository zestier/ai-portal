// Seed grants: the curated set of structured permission grants that
// every user starts with. Inserted when a user row is first created, and
// visible in the settings page so users can audit / revoke them.
//
// NOTE ON ROLLOUT: seeding runs on user *creation* only (see the call sites in
// `db/repos/users.ts`), not on every login. So adding a seed here does NOT
// retroactively grant it to existing users — they pick it up via the Settings
// "Restore default seed grants" button (`restoreSeedGrantsForUser`). That is
// deliberate: re-running the seeder on each login would resurrect seeds a user
// intentionally revoked, silently handing back an auto-approval they removed.
//
// THE SAME PROPERTY CUTS THE OTHER WAY, AND IT IS EASY TO MISS. Widening is
// merely delayed; TIGHTENING AN EXISTING SEED IS INERT. Narrowing a seed here
// (adding a deny to its option list, bounding its positional count) does not
// edit the row an existing user already has — it produces a row with a NEW
// scope key, and `ensureSeedGrantsForUser` is insert-only, so the older, more
// permissive row survives and keeps matching first. Adding a `deny` seed does
// not help either: that is also just another row they never receive. Only two
// things reach an existing install — a change to the PREDICATE (code), or the
// user pressing "Restore default seed grants", which deletes `source='seed'`
// rows before reinserting. Security-relevant narrowing should therefore either
// live in the predicate or be announced as needing a restore.
//
// These replace the old hand-curated shell safe-list (which lived in
// code, was invisible to users, and ran *before* the matcher). By
// expressing the safe behavior as real grants we get one code path
// instead of two, and users can disable any seed they don't trust.
//
// Three flavors of seed:
//   1. `allow` (Approve in the UI) seeds make safe shell calls
//      and structured tools pass without prompting.
//   2. `prompt` seeds require human approval for requests not covered by
//      matching allow seeds, while still allowing a human escalation path.
//   3. `deny` seeds block known escape hatches such as risky Git global
//      options that change repository, worktree, config, namespace, or
//      execution context.

import {
	FS_PERMISSIONS,
	type GrantScope,
	type ShellCommandStep,
	type ShellOptionSpec,
	type ShellRule
} from '$lib/permissions/scope-types';
import { stableScopeKey } from '$lib/permissions/scope-codec';
import { addGrant, listGrantsForUser, revokeGrant } from '../db/repos/settings';

interface SeedSpec {
	tool: string;
	permissionKind: string | null;
	scope?: GrantScope | null;
	scopePattern?: string | null;
	decision?: 'allow' | 'deny' | 'prompt';
	denyReason?: string;
}

/**
 * Shell tools with no path arguments (pure stdout-only utilities). Safe
 * to allow with any positionals because they don't touch the filesystem
 * beyond reading their own argv.
 *
 * Deliberately NOT moved to `readable-paths` with the fs-read tools: these
 * never open a file. `basename` / `dirname` take path-SHAPED operands but only
 * do string surgery on them, so requiring a `read` grant would refuse a
 * perfectly safe call and teach users to over-grant.
 */
const PURE_UTILS = [
	'echo',
	'printf',
	'pwd',
	'date',
	'whoami',
	'hostname',
	'uname',
	'true',
	'false',
	'basename',
	'dirname',
	'yes',
	// `tr` sits here rather than with the fs-read tools because it has no file
	// operands at all: its positionals are SET1 / SET2 (character sets), and it
	// only ever transforms stdin. Judging those as paths was the same category
	// error the old `grep` seed made — `tr -d /` names the character `/`, not
	// the root directory, and a path rule refuses it for a reason that does not
	// exist. It cannot open, read, or write a file, so `any` is the honest rule.
	'tr'
];

/**
 * One audited shell tool that is seeded with a PATH-SHAPED positional rule.
 *
 * `audit` is REQUIRED and is the point of the shape: a `PositionalsRule`
 * constrains POSITIONALS only, so adding a tool here without having looked for
 * file-valued options and output positionals silently widens the boundary.
 * The registries below are the single source of every such seed, and
 * `AUDITED_PATH_SHAPED_TOOLS` is exported so a test can assert the converse —
 * that no path-shaped allow seed exists for a token that was never audited.
 */
interface ReaderSeed {
	token: string;
	options?: ShellCommandStep['options'];
	/**
	 * Upper bound on positionals, for tools whose LATER operands are outputs
	 * rather than inputs. See `uniq`.
	 */
	maxPositionals?: number;
	/** What the audit found: the dangerous options/operands, or that there are none. */
	audit: string;
}

/**
 * Read-only file tools. Seeded twice: once on `workspace-paths` (the floor —
 * exactly the behavior that shipped before, covering the conversation's
 * workspace and its worktree leases) and once on `readable-paths`, which defers
 * to the user's `read` grants so a path they made readable for `view` is
 * readable for `cat` too.
 *
 * The pair exists because the two answer different questions and neither alone
 * is right. Dropping the floor would narrow reads for anyone whose `read`
 * grants don't happen to cover their workspace — including an orchestrator
 * reading a sub-agent's lease. Dropping the deferring seed is the status quo
 * this ticket exists to fix: the user mirrors every readable path into a shell
 * grant by hand, and a refusal blames a workspace boundary that isn't the real
 * reason.
 *
 * Being additive is deliberate. "Restore default seed grants" must not take a
 * capability away from an existing install, and with the floor retained it
 * cannot.
 *
 * IMPORTANT — these rules constrain POSITIONALS. There are exactly two ways a
 * seeded "reader" can still touch a path no positional rule ever saw, and every
 * entry below has been audited for both:
 *
 *   1. A FILE-VALUED OPTION. With a deny-only list, any option token that
 *      survives the deny check falls through as permitted and its value is
 *      never added to `positionals`, so it escapes `workspace-paths` and
 *      `readable-paths` alike. `sort --output=FILE` was a full arbitrary WRITE
 *      with pipe-supplied content; `sort --compress-program=PROG` is arbitrary
 *      EXECUTION; `--files0-from` / `file -f` / `sha256sum -c` all read paths
 *      named in a file's CONTENT. These can only be closed by denying the
 *      option at the source.
 *   2. An OUTPUT POSITIONAL. `uniq INPUT OUTPUT` truncates its second operand.
 *      That operand IS checked — but against the READ grants, because the rule
 *      kind is `readable-paths` — so a path made merely readable becomes
 *      writable. `PositionalsRule` has no per-operand form ("operand 1
 *      readable, operand 2 writable"), and adding one is not the fix HERE: a
 *      seeded reader does not want the operand at all, so the answer is to
 *      bound the COUNT (`maxPositionals`) and let two-operand calls prompt. A
 *      user-authored grant that genuinely needs mixed operand roles is a
 *      separate, still-open capability.
 *
 * Denying a file-valued option outright is likewise the right move for a
 * READER, but not the only shape available: `ShellOptionSpec` can carry a
 * `ShellOptionValueRule` on the value, which is the extension point if some
 * future seed wants to permit a file-valued option BOUNDED to a path set
 * rather than refuse it. Note that would not rescue the `--files0-from` family:
 * validating the list file says nothing about the paths named inside it.
 *
 * Why deny-lists here rather than the safer allow-lists: `matchShellOptionToken`
 * matches an allow spec as a whole token (or `--name=value`) and knows nothing
 * about getopt clusters or attached short values, so an allow-list on these
 * tools would refuse `ls -la`, `head -n5`, `sort -bf` and every other ordinary
 * bundled invocation. The deny side is where the cluster-awareness lives (see
 * `matchesDeniedOption`), so that is where the boundary is enforced.
 */
const FS_READ_TOOLS: ReaderSeed[] = [
	{ token: 'cat', audit: 'no file-valued options; every positional is an input file.' },
	{ token: 'head', audit: 'no file-valued options; every positional is an input file.' },
	{
		token: 'tail',
		audit: 'no file-valued options (`-f` follows, it does not name a file); inputs only.'
	},
	{
		token: 'file',
		// `-C`/`--compile` WRITES a compiled magic file (`<magic>.mgc`);
		// `-m`/`--magic-file` reads arbitrary magic files; `-f`/`--files-from`
		// examines paths named inside a file's content. None are positionals.
		options: { deny: ['-C', '--compile', '-m', '--magic-file', '-f', '--files-from'] },
		audit: '`-C/--compile` writes a .mgc file; `-m` and `-f` name files that are never positionals.'
	},
	{
		token: 'stat',
		audit: 'no file-valued options — `--printf`/`-c` are formats to stdout, `-f` is --file-system.'
	},
	{ token: 'ls', audit: 'no file-valued options — `--hide`/`-I` take patterns, not paths.' },
	{
		token: 'sort',
		// `-o`/`--output` WRITES (arbitrary content over a pipe);
		// `--compress-program` EXECUTES an arbitrary program on the temp files;
		// `--files0-from` and `--random-source` read a file that is not a
		// positional; `-T` creates temp files in an arbitrary directory.
		options: {
			deny: [
				'-o',
				'--output',
				'--files0-from',
				'--compress-program',
				'--random-source',
				'-T',
				'--temporary-directory'
			]
		},
		audit:
			'`-o` writes, `--compress-program` executes, `--files0-from`/`--random-source`/`-T` name unchecked paths.'
	},
	{
		token: 'uniq',
		// `uniq INPUT OUTPUT` creates/truncates OUTPUT. Bounding the count to
		// one operand keeps the reader a reader; two-operand calls prompt.
		//
		// KNOWN COST: the matcher does not know which options take values, so a
		// SEPARATED value counts as a positional — `uniq -f 2 file` (three
		// tokens, two positionals) now prompts, while the attached `uniq -f2
		// file` still auto-approves. That asymmetry is the price of bounding
		// the count without an option grammar, and it fails in the safe
		// direction: the refusal is a prompt, not a denial.
		maxPositionals: 1,
		audit:
			'no file-valued options, but the SECOND positional is an OUTPUT file — bounded to one. ' +
			'Side effect: separated option values (`-f 2`) count as positionals and prompt.'
	},
	{
		token: 'cut',
		audit: 'no file-valued options — `--output-delimiter` is a string, not a path.'
	},
	{
		token: 'realpath',
		audit:
			'`--relative-to`/`--relative-base` are path-shaped but resolution-only: no open, no write.'
	},
	{ token: 'readlink', audit: 'no file-valued options; resolution only.' },
	...['md5sum', 'sha1sum', 'sha256sum'].map(
		(token): ReaderSeed => ({
			token,
			// `-c`/`--check` hashes every path named INSIDE the checklist file.
			// Only the checklist itself is a positional, so the paths it names
			// are checked by nothing — structurally identical to
			// `sort --files0-from`, and it turns the tool into an oracle for
			// files outside the read grants. Verifying a checksum file still
			// works, it just prompts.
			options: { deny: ['-c', '--check'] },
			audit:
				'`-c/--check` reads every path named inside the checklist file; those are not positionals.'
		})
	)
];

/**
 * Path-search tools. Like the fs-read tools above they get a `workspace-paths`
 * floor plus a `readable-paths` seed, so searching somewhere the user granted
 * `read` no longer needs a hand-mirrored shell grant. An explicit opt-in prompt
 * seed still covers searching beyond both, and command-running options are
 * denied outright.
 *
 * `find` stays here rather than being steered to a structured tool because
 * `glob` doesn't cover its predicates (`-mtime`, `-size`, `-type`, ...) and
 * it prints paths, not file contents.
 */
const PATH_SEARCH_TOOLS: ReaderSeed[] = [
	{
		token: 'find',
		// The exec family runs commands; the -fprint/-fls family CREATES AND
		// TRUNCATES its FILE operand. The latter matters especially now that this
		// seed defers to the `read` grants: without the denies, `find <dir> -fls
		// <path>` would let a path the user only made READABLE be written to,
		// turning a read grant into a write. `-fprint0` and `-fls` are easy to
		// miss — deny matching does not derive variants, so `-fprint` does not
		// cover `-fprint0`.
		//
		// `-files0-from FILE` (findutils >= 4.9) takes the start points from a
		// file's CONTENT, so the directories actually walked are named by no
		// positional and escape both the workspace floor and the read grants.
		options: {
			deny: [
				'-exec',
				'-execdir',
				'-ok',
				'-okdir',
				'-delete',
				'-fprint',
				'-fprint0',
				'-fprintf',
				'-fls',
				'-files0-from'
			]
		},
		audit:
			'the -exec/-ok family executes; -fprint/-fprintf/-fprint0/-fls truncate their FILE operand; ' +
			'-files0-from takes start points from a file. All denied; -newer/-samefile only stat their operand.'
	}
];

/**
 * Every tool token permitted to carry a PATH-SHAPED positional rule in the
 * default seeds, mapped to its audit finding. Exported so the seed tests can
 * assert the CONVERSE of the registry: that no allow seed hands a path-shaped
 * rule (`workspace-paths` / `session-workspace-paths` / `readable-paths`) to a
 * token nobody audited. Without that check the required `audit` field would
 * only constrain entries someone already chose to put in a registry, and a
 * hand-rolled `shellGrant(shellCommand('perl', { kind: 'workspace-paths' }))`
 * would slip past it entirely.
 */
export const AUDITED_PATH_SHAPED_TOOLS: Readonly<
	Record<string, { audit: string; maxPositionals?: number | undefined }>
> = Object.fromEntries(
	[...FS_READ_TOOLS, ...PATH_SEARCH_TOOLS].map(({ token, audit, maxPositionals }) => [
		token,
		{ audit, maxPositionals }
	])
);

/**
 * Content-search tools, seeded ONLY as pipe filters.
 *
 * These used to sit alongside `find` on `positionals: workspace-paths`,
 * which was wrong in both directions. Their first positional is a regex,
 * not a path: `isPathInWorkspace` resolves a non-path pattern against the
 * workspace root, so most patterns passed by accident while a pattern
 * containing `..` or a leading `/` failed and produced the nonsense
 * feedback "searching outside the workspace" for a search that never named
 * a path at all.
 *
 * The deeper problem is the capability boundary. Used against files, shell
 * `grep`/`rg` are a file-reading path whose scope is decided by shell rules
 * rather than the fs read grants, so they disagree with `view`/`grep` about
 * what is readable — in both directions — for no benefit: the structured
 * `grep` tool is ripgrep, with globs, output modes, context and multiline.
 * The one thing no structured tool can do is filter ANOTHER command's
 * stdout (`pnpm test | grep -c FAIL`).
 *
 * So the seed grants exactly that capability: `pipeline: 'pipe-target'`
 * (must consume a pipe — note `grep x file | head` does NOT qualify, since
 * grep is the producer there) composed with `positionals: 'any'` and a
 * positional count of at most 1. The count bound is what does the real
 * work: the lone operand is the pattern, and a second one is a file to
 * read, so `echo x | grep root /etc/shadow` can't ride in on the pipe.
 * `any` is the right shape rule precisely because a regex is not a path and
 * must not be containment-checked. Options that make the command read files
 * anyway are denied. Everything else falls through to the prompt seed
 * below, which points at the `grep` tool.
 *
 * Note these deliberately did NOT move to `readable-paths` alongside the
 * fs-read tools. It would be the same category error the old `workspace-paths`
 * seed made, just with a different boundary: the lone positional is a PATTERN,
 * so resolving it as a path and asking the read grants about it is meaningless
 * — `grep root` would be judged as the file `./root`. The count bound, not a
 * path rule, is what stops file operands here.
 */
const STDIN_FILTER_TOOLS: { token: string; options?: ShellCommandStep['options'] }[] = [
	{
		token: 'rg',
		options: {
			deny: ['--pre', '--pre-glob', '--hostname-bin', '--no-config', '-f', '--file']
		}
	},
	{
		token: 'grep',
		options: { deny: ['-f', '--file', '-r', '-R', '--recursive', '-d', '--directories'] }
	}
];

const STDIN_FILTER_PROMPT_REASON =
	'is seeded only as a pipe filter (`some-command | %TOKEN% pattern`), where it reads stdin. Searching files with it requires approval — use the structured `grep` tool instead: it is ripgrep, it honors the same read scopes as `view`, and it supports globs, context lines, multiline and output_mode count/files_with_matches.';

const GIT_STRUCTURED_TOOLS = [
	'git_status',
	'git_diff',
	'git_log',
	'git_show_commit',
	'git_show_file',
	// Read-only, like the rest of this list. The mutating worktree tool
	// (`git_worktree_merge`) is deliberately absent, same as `git_commit`: it
	// declares `permissionBehavior: 'always-prompt'` and must stay promptable.
	'git_worktree_status',
	'git_worktree_list'
];
/**
 * Workspace ticket bookkeeping. Edges are wired through `ticket_update`'s
 * `blockedBy` / `blocks` fields, which replace whole edge sets declaratively.
 */
const TICKET_STRUCTURED_TOOLS = ['ticket_add', 'ticket_list', 'ticket_get', 'ticket_update'];
const PERMISSION_STRUCTURED_TOOLS = ['permission_capabilities'];

/**
 * Read-only worktree-lease inspection, seeded for the same reason as
 * `git_worktree_status`: an orchestrator polls these to find out which of its
 * parallel sub-agents have finished. Unseeded they require a prompt, which
 * under the `auto-deny` approval mode is an auto-deny — so an unattended
 * orchestrator could not even enumerate its own worktrees.
 *
 * The mutating tools (`worktree_create`, `_merge`, `_remove`) are deliberately
 * absent, matching `git_commit` / `git_worktree_merge`: they create or destroy
 * checkouts and branches, and `_merge`/`_remove` declare
 * `permissionBehavior: 'always-prompt'` so a grant could not auto-approve them
 * anyway. Absent from the DEFAULTS is not the same as unreachable: a user who
 * wants `worktree_create` to stop prompting can author the same
 * custom-tool grant by hand in Settings → Permissions.
 */
const WORKTREE_STRUCTURED_TOOLS = ['worktree_list', 'worktree_status'];
const RISKY_GIT_GLOBAL_OPTIONS = [
	'--bare',
	'--no-replace-objects',
	'--no-lazy-fetch',
	'-c',
	'-C',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--config-env',
	'--exec-path'
];
const RISKY_GIT_GLOBAL_PATTERNS = RISKY_GIT_GLOBAL_OPTIONS.flatMap((option) => {
	if (option === '-c' || option === '-C') {
		return [
			{ option, pattern: `git ${option} *` },
			{ option, pattern: `git ${option}=*` },
			{ option, pattern: `git * ${option} *` },
			{ option, pattern: `git * ${option}=*` }
		];
	}
	if (option === '--bare' || option === '--no-replace-objects' || option === '--no-lazy-fetch') {
		return [
			{ option, pattern: `git ${option}` },
			{ option, pattern: `git ${option} *` },
			{ option, pattern: `git * ${option}` },
			{ option, pattern: `git * ${option} *` }
		];
	}
	return [
		{ option, pattern: `git ${option} *` },
		{ option, pattern: `git ${option}=*` },
		{ option, pattern: `git * ${option} *` },
		{ option, pattern: `git * ${option}=*` }
	];
});
const SAFE_GIT_GLOBAL_OPTIONS: ShellOptionSpec[] = [
	{ name: '--paginate', kind: 'flag' },
	{ name: '--no-pager', kind: 'flag' },
	{ name: '--literal-pathspecs', kind: 'flag' },
	{ name: '--glob-pathspecs', kind: 'flag' },
	{ name: '--noglob-pathspecs', kind: 'flag' },
	{ name: '--icase-pathspecs', kind: 'flag' },
	{ name: '--no-optional-locks', kind: 'flag' }
];
const GIT_STRUCTURED_SUBCOMMAND_DENIES: { subcommand: string; tools: string }[] = [
	{ subcommand: 'status', tools: 'git_status' },
	{ subcommand: 'diff', tools: 'git_diff' },
	{ subcommand: 'log', tools: 'git_log' },
	{ subcommand: 'show', tools: 'git_show_commit or git_show_file' },
	{ subcommand: 'commit', tools: 'git_commit' }
];

function shellGrant(rule: ShellRule): SeedSpec {
	return { tool: 'shell', permissionKind: 'shell', scope: { kind: 'shell', rule } };
}

function shellCommand(
	token: string,
	positionals: ShellRule['positionals'],
	options?: ShellCommandStep['options']
): ShellRule {
	const step: ShellCommandStep = { token };
	if (options) step.options = options;
	return {
		command: [step],
		...(positionals !== undefined ? { positionals } : {})
	};
}

/**
 * A grant-deferring reader seed only fires when there is at least one operand
 * to actually check. Without this it would match vacuously on a zero-positional
 * invocation and auto-approve on the strength of a rule that examined nothing.
 */
function deferredReader(rule: ShellRule): ShellRule {
	return { ...rule, positionalCount: { ...rule.positionalCount, min: 1 } };
}

/** Applies a reader's audited upper bound on operands, if it has one. */
function boundPositionals(rule: ShellRule, max: number | undefined): ShellRule {
	if (max === undefined) return rule;
	return { ...rule, positionalCount: { ...rule.positionalCount, max } };
}

function shellPrompt(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'prompt',
		denyReason: reason
	};
}

function shellDeny(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'deny',
		denyReason: reason
	};
}

function shellPatternDeny(pattern: string, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scopePattern: pattern,
		decision: 'deny',
		denyReason: reason
	};
}

function riskyGitGlobalOptionFeedback(option: string): string {
	return `Shell \`git ${option}\` is denied because it can change repository, worktree, config, namespace, or execution context. Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit tools where applicable.`;
}

function gitStructuredSubcommandFeedback(subcommand: string, tools: string): string {
	const toolNoun = tools.includes(' or ') ? 'tools' : 'tool';
	return `Shell \`git ${subcommand}\` is denied. Use ${tools} ${toolNoun}.`;
}

// `wc` is denied by default and steered to the structured grep tool. The
// dominant real use is `wc -l` (line count), which the grep tool covers via
// `output_mode: 'count'` with the pattern `^` (every line matches once).
// Word/byte counts are intentionally NOT offered a recipe: count mode counts
// matching LINES, not occurrences, so it can't produce a word count — those
// rare needs escalate via `force_retry_tool`.
const WC_SHELL_DENY_FEEDBACK =
	'Shell `wc` is denied by default. To count lines use the grep tool with output_mode count and the pattern ^ (it matches every line). For word or byte counts, escalate sparingly with `force_retry_tool` (token from the denial) only if no structured tool fits.';

/**
 * Terminal-usage prompt rules. Since regular allow grants outrank prompt
 * grants, these only affect invocations that are not also covered by an allow
 * seed — i.e. a read of a path the user's `read` grants don't reach.
 *
 * The reasons deliberately do NOT claim a workspace boundary: the allow seeds
 * are grant-shaped now, so the boundary is whatever the `read` grants say. The
 * matcher appends the specific near-miss (``/etc/passwd` is not covered by your
 * `read` grants`), so these only need to name the structured alternative.
 */
const PROMPT_SEEDS: { argv0: string; reason: string }[] = [
	{
		argv0: 'cat',
		reason:
			'`cat` on a path your `read` grants do not cover requires a prompt. Use `view` for file reads.'
	},
	{
		argv0: 'head',
		reason:
			'`head` on a path your `read` grants do not cover requires a prompt. Use `view` with `view_range`.'
	},
	{
		argv0: 'tail',
		reason:
			'`tail` on a path your `read` grants do not cover requires a prompt. Use `view` with `view_range`.'
	},
	{
		argv0: 'ls',
		reason:
			'`ls` on a path your `read` grants do not cover requires a prompt. Use `glob` to enumerate files.'
	}
];

export function defaultSeedGrants(): SeedSpec[] {
	const seeds: SeedSpec[] = [];

	for (const argv0 of PURE_UTILS) {
		seeds.push(shellGrant(shellCommand(argv0, { kind: 'any' })));
	}
	// Read-only shell tools get TWO allow seeds, and the pair is the whole
	// design:
	//
	//   * `workspace-paths` — the FLOOR. Exactly today's behavior, covering the
	//     conversation's workspace plus every worktree lease it holds. Keeping
	//     it is what makes this migration purely additive: nothing a user could
	//     do before stops working, including reading a sub-agent's lease files.
	//   * `readable-paths`  — the GROWTH. Whatever the user's `read` grants say,
	//     so a path they made readable for `view` is readable for `cat` too,
	//     without mirroring it into a shell grant.
	//
	// `session-workspace-paths` is deliberately NOT seeded any more: the
	// session-workspace fs read seed above already expresses that same set, and
	// `readable-paths` now honors it. A user who revokes that fs seed should
	// lose the shell reads with it — that was the divergence to begin with.
	//
	// The deferring seed carries `positionalCount: {min: 1}` so it can never
	// grant vacuously. Zero-positional invocations (`cat` reading stdin in a
	// pipe, bare `ls`) name no path to check, so they belong to the floor seed
	// and keep their existing behavior rather than being auto-approved by a rule
	// that checked nothing.
	for (const { token, options, maxPositionals } of FS_READ_TOOLS) {
		seeds.push(
			shellGrant(
				boundPositionals(shellCommand(token, { kind: 'workspace-paths' }, options), maxPositionals)
			)
		);
		seeds.push(
			shellGrant(
				deferredReader(
					boundPositionals(shellCommand(token, { kind: 'readable-paths' }, options), maxPositionals)
				)
			)
		);
	}
	for (const tool of GIT_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const tool of TICKET_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const tool of WORKTREE_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const tool of PERMISSION_STRUCTURED_TOOLS) {
		seeds.push({ tool, permissionKind: 'custom-tool', scope: { kind: 'any' } });
	}
	for (const perm of FS_PERMISSIONS) {
		seeds.push({
			tool: perm,
			permissionKind: perm,
			scope: {
				kind: 'fs',
				perms: [perm],
				rule: { kind: 'path', root: 'session-workspace', behavior: 'any' }
			}
		});
	}

	seeds.push(
		shellPrompt(
			{ command: [{ token: 'git' }] },
			'Shell `git` requires a prompt. Use `permission_capabilities` to find allowed alternatives, then use an available structured Git tool instead.'
		)
	);
	for (const { option, pattern } of RISKY_GIT_GLOBAL_PATTERNS) {
		seeds.push(shellPatternDeny(pattern, riskyGitGlobalOptionFeedback(option)));
	}
	for (const { subcommand, tools } of GIT_STRUCTURED_SUBCOMMAND_DENIES) {
		seeds.push(
			shellDeny(
				{
					command: [
						{ token: 'git', options: { allow: SAFE_GIT_GLOBAL_OPTIONS } },
						{ token: subcommand }
					],
					positionals: { kind: 'any' }
				},
				gitStructuredSubcommandFeedback(subcommand, tools)
			)
		);
	}

	// `wc` is denied (any args, in or out of workspace) and steered to the
	// structured grep tool for line counts. A bare-token rule with `any`
	// positionals also covers `cat foo | wc -l`, since the matcher checks
	// hard-denies across every pipeline segment first.
	seeds.push(
		shellDeny({ command: [{ token: 'wc' }], positionals: { kind: 'any' } }, WC_SHELL_DENY_FEEDBACK)
	);

	// find: a read-only path-search tool, seeded on the same floor + growth pair
	// as the fs-read tools above. `workspace-paths` keeps today's behavior
	// (including bare `find`, whose implicit operand is the cwd); the
	// `readable-paths` seed adds whatever the user's `read` grants cover and,
	// via `min: 1`, never fires without a path it actually checked. Its
	// command-running options are denied in both.
	for (const { token, options, maxPositionals } of PATH_SEARCH_TOOLS) {
		seeds.push(
			shellGrant(
				boundPositionals(shellCommand(token, { kind: 'workspace-paths' }, options), maxPositionals)
			)
		);
		seeds.push(
			shellGrant(
				deferredReader(
					boundPositionals(shellCommand(token, { kind: 'readable-paths' }, options), maxPositionals)
				)
			)
		);
	}

	// "Search anywhere" opt-in: a clearly-labeled prompt seed per path-search
	// tool. Because allow seeds outrank prompt seeds, searches within the
	// readable paths still auto-approve via the grants above; only searches that
	// reach past them land here and require an explicit human approval (or the
	// user can add their own read grant, which the allow seed then honors).
	for (const { token, options, maxPositionals } of PATH_SEARCH_TOOLS) {
		seeds.push(
			shellPrompt(
				boundPositionals(shellCommand(token, { kind: 'any' }, options), maxPositionals),
				`\`${token}\` searching outside the paths your \`read\` grants permit requires approval (opt-in "search anywhere"). Readable paths are auto-approved; approve to search elsewhere this once, or add a \`read\` grant covering it to always allow it.`
			)
		);
	}

	// grep / rg: allowed only as a pipe filter over another command's
	// stdout, with no file operands. Anything else — including
	// `grep pattern file` and `grep pattern file | head`, where grep is the
	// pipeline's producer rather than its target — falls through to the
	// prompt seed and is steered to the structured `grep` tool.
	for (const { token, options } of STDIN_FILTER_TOOLS) {
		const rule = shellCommand(token, { kind: 'any' }, options);
		rule.positionalCount = { max: 1 };
		rule.pipeline = 'pipe-target';
		seeds.push(shellGrant(rule));
	}
	for (const { token } of STDIN_FILTER_TOOLS) {
		seeds.push(
			shellPrompt(
				shellCommand(token, { kind: 'any' }),
				`Shell \`${token}\` ${STDIN_FILTER_PROMPT_REASON.replace('%TOKEN%', token)}`
			)
		);
	}

	// Prompt only when no allow seed also covers the command.
	for (const { argv0, reason } of PROMPT_SEEDS) {
		seeds.push(shellPrompt({ command: [{ token: argv0 }], pipeline: 'forbid' }, reason));
	}

	return seeds;
}

/**
 * Insert the default seed grants for `userId` iff they're not already
 * present. We key dedup on (tool, permission_kind, scope_json, decision)
 * — the structured representation uniquely identifies the seed, so a
 * user who has manually deleted one won't see it return on next login.
 *
 * Re-running this function is a no-op when the user already has all
 * seeds. To restore a deleted seed, the user re-adds it from the UI.
 */
export function ensureSeedGrantsForUser(userId: number): number {
	const existing = listGrantsForUser(userId);
	const haveKey = new Set<string>();
	for (const g of existing) {
		haveKey.add(seedKey(g.tool, g.permissionKind, g.scope, g.scopePattern, g.decision));
	}

	let inserted = 0;
	for (const seed of defaultSeedGrants()) {
		const decision = seed.decision ?? 'allow';
		const key = seedKey(
			seed.tool,
			seed.permissionKind,
			seed.scope ?? null,
			seed.scopePattern ?? null,
			decision
		);
		if (haveKey.has(key)) continue;
		addGrant({
			userId,
			conversationId: null,
			tool: seed.tool,
			permissionKind: seed.permissionKind,
			scope: seed.scope ?? null,
			scopePattern: seed.scopePattern ?? null,
			decision,
			denyReason: seed.denyReason ?? null,
			source: 'seed'
		});
		haveKey.add(key);
		inserted += 1;
	}
	return inserted;
}

/**
 * Replace every identifiable user-global default seed grant with the current
 * default set. This powers the Settings "Restore default seed grants" button:
 * unlike login-time seeding, it intentionally removes stale default rows first
 * so old seed shapes (for example hard-deny prompts that are now prompt rules) do not
 * keep winning by matcher precedence.
 */
export function restoreSeedGrantsForUser(userId: number): { removed: number; inserted: number } {
	const defaultKeys = restoreSeedKeys();
	let removed = 0;
	for (const grant of listGrantsForUser(userId)) {
		if (grant.conversationId !== null) continue;
		if (grant.argsHash) continue;
		// Checked-in `.zap/permissions.toml` rows are workspace policy the
		// human explicitly imported; "restore defaults" must never touch them,
		// even when a file grant happens to match a default seed's key.
		if (grant.source === 'workspace-file') continue;
		if (grant.source !== 'seed') {
			if (
				!defaultKeys.has(
					seedKey(grant.tool, grant.permissionKind, grant.scope, grant.scopePattern, grant.decision)
				)
			) {
				continue;
			}
		}
		if (revokeGrant(userId, grant.id)) removed += 1;
	}
	return { removed, inserted: ensureSeedGrantsForUser(userId) };
}

function seedKey(
	tool: string,
	kind: string | null,
	scope: GrantScope | null,
	pattern: string | null,
	decision: string
): string {
	return `${tool}\u0000${kind ?? ''}\u0000${decision}\u0000${scope ? stableScopeKey(scope) : `pattern:${pattern ?? ''}`}`;
}

function restoreSeedKeys(): Set<string> {
	const keys = new Set<string>();
	for (const seed of defaultSeedGrants()) {
		const decision = seed.decision ?? 'allow';
		keys.add(
			seedKey(
				seed.tool,
				seed.permissionKind,
				seed.scope ?? null,
				seed.scopePattern ?? null,
				decision
			)
		);
		if (decision === 'prompt') {
			keys.add(
				seedKey(
					seed.tool,
					seed.permissionKind,
					seed.scope ?? null,
					seed.scopePattern ?? null,
					'deny'
				)
			);
		}
	}
	return keys;
}
