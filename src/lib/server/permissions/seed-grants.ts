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
	'yes'
];

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
 * IMPORTANT — these rules constrain POSITIONALS, not option VALUES. A tool with
 * a file-valued option can therefore touch a path no positional rule ever saw,
 * so any such option must be denied explicitly here. `sort` is the sharp case:
 * `sort --output=FILE` is a full arbitrary WRITE (content supplied over a pipe)
 * that the `write`/`edit` grants would never see, and `--files0-from=FILE`
 * reads a list of files to print. Both take zero positionals, so every
 * positional rule passes vacuously. Deny them at the source.
 */
const FS_READ_TOOLS: { token: string; options?: ShellCommandStep['options'] }[] = [
	{ token: 'cat' },
	{ token: 'head' },
	{ token: 'tail' },
	{ token: 'file' },
	{ token: 'stat' },
	{ token: 'ls' },
	{
		token: 'sort',
		// `-o`/`--output` writes; `--files0-from` reads a file list. See above.
		options: { deny: ['-o', '--output', '--files0-from'] }
	},
	{ token: 'uniq' },
	{ token: 'cut' },
	{ token: 'tr' },
	{ token: 'realpath' },
	{ token: 'readlink' },
	{ token: 'md5sum' },
	{ token: 'sha1sum' },
	{ token: 'sha256sum' }
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
const PATH_SEARCH_TOOLS: { token: string; options?: ShellCommandStep['options'] }[] = [
	{
		token: 'find',
		// The exec family runs commands; the -fprint/-fls family CREATES AND
		// TRUNCATES its FILE operand. The latter matters especially now that this
		// seed defers to the `read` grants: without the denies, `find <dir> -fls
		// <path>` would let a path the user only made READABLE be written to,
		// turning a read grant into a write. `-fprint0` and `-fls` are easy to
		// miss — deny matching is exact (or `opt=`), so `-fprint` does not cover
		// `-fprint0`.
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
				'-fls'
			]
		}
	}
];

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
 * Workspace ticket bookkeeping. `ticket_block` / `ticket_unblock` are seeded
 * alongside the rest because they are strictly less capable than the already
 * seeded `ticket_update`, whose `blockedBy` / `blocks` fields replace whole
 * edge sets declaratively — leaving them out withheld nothing and only made
 * ordering follow-up work prompt, which is an auto-deny under
 * `best-effort`/autopilot even though the portal guidance tells agents to link
 * tickets with `ticket_block`.
 *
 * The attachment tools stay out on purpose: `ticket_attach` reads an arbitrary
 * path off disk, so it belongs to the filesystem grants rather than this list,
 * and `ticket_detach` destroys a stored blob.
 */
const TICKET_STRUCTURED_TOOLS = [
	'ticket_add',
	'ticket_list',
	'ticket_get',
	'ticket_update',
	'ticket_block',
	'ticket_unblock'
];
const PERMISSION_STRUCTURED_TOOLS = ['permission_capabilities'];

/**
 * Read-only worktree-lease inspection, seeded for the same reason as
 * `git_worktree_status`: an orchestrator polls these to find out which of its
 * parallel sub-agents have finished. Unseeded they require a prompt, which
 * under `best-effort`/autopilot is an auto-deny — so an unattended orchestrator
 * could not even enumerate its own worktrees.
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
	return { ...rule, positionalCount: { min: 1 } };
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
// rare needs escalate via `forcePermissionPrompt`.
const WC_SHELL_DENY_FEEDBACK =
	'Shell `wc` is denied by default. To count lines use the grep tool with output_mode count and the pattern ^ (it matches every line). For word or byte counts, escalate sparingly with `forcePermissionPrompt` only if no structured tool fits.';

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
	for (const { token, options } of FS_READ_TOOLS) {
		seeds.push(shellGrant(shellCommand(token, { kind: 'workspace-paths' }, options)));
		seeds.push(
			shellGrant(deferredReader(shellCommand(token, { kind: 'readable-paths' }, options)))
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
	for (const { token, options } of PATH_SEARCH_TOOLS) {
		seeds.push(shellGrant(shellCommand(token, { kind: 'workspace-paths' }, options)));
		seeds.push(
			shellGrant(deferredReader(shellCommand(token, { kind: 'readable-paths' }, options)))
		);
	}

	// "Search anywhere" opt-in: a clearly-labeled prompt seed per path-search
	// tool. Because allow seeds outrank prompt seeds, searches within the
	// readable paths still auto-approve via the grants above; only searches that
	// reach past them land here and require an explicit human approval (or the
	// user can add their own read grant, which the allow seed then honors).
	for (const { token, options } of PATH_SEARCH_TOOLS) {
		seeds.push(
			shellPrompt(
				shellCommand(token, { kind: 'any' }, options),
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
export function ensureSeedGrantsForUser(userId: string): number {
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
export function restoreSeedGrantsForUser(userId: string): { removed: number; inserted: number } {
	const defaultKeys = restoreSeedKeys();
	let removed = 0;
	for (const grant of listGrantsForUser(userId)) {
		if (grant.conversationId !== null) continue;
		if (grant.argsHash) continue;
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
