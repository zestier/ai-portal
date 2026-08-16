import type { ShellCommandStep } from '$lib/permissions/scope-types';

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
export interface ReaderSeed {
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
export const FS_READ_TOOLS: ReaderSeed[] = [
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
export const PATH_SEARCH_TOOLS: ReaderSeed[] = [
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
export const STDIN_FILTER_TOOLS: { token: string; options?: ShellCommandStep['options'] }[] = [
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

export const STDIN_FILTER_PROMPT_REASON =
	'is seeded only as a pipe filter (`some-command | %TOKEN% pattern`), where it reads stdin. Searching files with it requires approval — use the structured `grep` tool instead: it is ripgrep, it honors the same read scopes as `view`, and it supports globs, context lines, multiline and output_mode count/files_with_matches.';

// `wc` is denied by default and steered to the structured grep tool. The
// dominant real use is `wc -l` (line count), which the grep tool covers via
// `output_mode: 'count'` with the pattern `^` (every line matches once).
// Word/byte counts are intentionally NOT offered a recipe: count mode counts
// matching LINES, not occurrences, so it can't produce a word count — those
// rare needs escalate via `force_retry_tool`.
export const WC_SHELL_DENY_FEEDBACK =
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
export const PROMPT_SEEDS: { argv0: string; reason: string }[] = [
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
