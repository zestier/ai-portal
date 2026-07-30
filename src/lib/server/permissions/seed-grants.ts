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
 * Read-only file tools. Locked to positionals inside the workspace so
 * `cat /etc/passwd` still prompts. Note: a user who wants to read
 * outside the workspace can add their own grant; we don't ship one.
 */
const FS_READ_TOOLS = [
	'cat',
	'head',
	'tail',
	'file',
	'stat',
	'ls',
	'sort',
	'uniq',
	'cut',
	'tr',
	'realpath',
	'readlink',
	'md5sum',
	'sha1sum',
	'sha256sum'
];

/**
 * Read-only search tools. Like the fs-read tools, their positionals are
 * locked to the workspace by default; an explicit opt-in prompt seed
 * covers searching outside it. Command-running / file-mutating options are
 * denied outright.
 */
const SEARCH_TOOLS: { token: string; options?: ShellCommandStep['options'] }[] = [
	{ token: 'rg', options: { deny: ['--pre', '--pre-glob', '--hostname-bin', '--no-config'] } },
	{ token: 'grep' },
	{
		token: 'find',
		options: { deny: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf'] }
	}
];

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
 * seed, such as bare file reads outside the workspace.
 */
const PROMPT_SEEDS: { argv0: string; reason: string }[] = [
	{
		argv0: 'cat',
		reason: 'Bare `cat` outside an allowed workspace requires a prompt. Use `view` for file reads.'
	},
	{
		argv0: 'head',
		reason:
			'Bare `head` outside an allowed workspace requires a prompt. Use `view` with `view_range`.'
	},
	{
		argv0: 'tail',
		reason:
			'Bare `tail` outside an allowed workspace requires a prompt. Use `view` with `view_range`.'
	},
	{
		argv0: 'ls',
		reason:
			'Bare `ls` outside an allowed workspace requires a prompt. Use `glob` to enumerate files.'
	}
];

export function defaultSeedGrants(): SeedSpec[] {
	const seeds: SeedSpec[] = [];

	for (const argv0 of PURE_UTILS) {
		seeds.push(shellGrant(shellCommand(argv0, { kind: 'any' })));
	}
	for (const argv0 of FS_READ_TOOLS) {
		seeds.push(shellGrant(shellCommand(argv0, { kind: 'workspace-paths' })));
		seeds.push(shellGrant(shellCommand(argv0, { kind: 'session-workspace-paths' })));
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

	// rg / grep / find: read-only search tools. Their command-running
	// options are denied, and — like the fs-read tools — their positionals
	// are locked to the workspace so `rg secret /etc/shadow`,
	// `grep -r password /`, and `find / -name '*.pem'` don't auto-approve
	// and leak data outside the workspace boundary. Searching anywhere is
	// still possible via the explicit opt-in prompt seeds below.
	for (const { token, options } of SEARCH_TOOLS) {
		seeds.push(shellGrant(shellCommand(token, { kind: 'workspace-paths' }, options)));
		seeds.push(shellGrant(shellCommand(token, { kind: 'session-workspace-paths' }, options)));
	}

	// "Search anywhere" opt-in: a clearly-labeled prompt seed per search
	// tool. Because allow seeds outrank prompt seeds, in-workspace searches
	// still auto-approve via the grants above; only searches that escape the
	// workspace land here and require an explicit human approval (or the
	// user can add their own allow grant). This keeps the capability without
	// silently auto-approving out-of-workspace reads.
	for (const { token, options } of SEARCH_TOOLS) {
		seeds.push(
			shellPrompt(
				shellCommand(token, { kind: 'any' }, options),
				`\`${token}\` searching outside the workspace requires approval (opt-in "search anywhere"). In-workspace searches are auto-approved; approve to allow searching other paths this once, or add your own grant to always allow it.`
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
