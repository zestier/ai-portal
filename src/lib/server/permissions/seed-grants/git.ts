import type { ShellOptionSpec } from '$lib/permissions/scope-types';

export const GIT_STRUCTURED_TOOLS = [
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
export const RISKY_GIT_GLOBAL_OPTIONS = [
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
export const RISKY_GIT_GLOBAL_PATTERNS = RISKY_GIT_GLOBAL_OPTIONS.flatMap((option) => {
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
export const SAFE_GIT_GLOBAL_OPTIONS: ShellOptionSpec[] = [
	{ name: '--paginate', kind: 'flag' },
	{ name: '--no-pager', kind: 'flag' },
	{ name: '--literal-pathspecs', kind: 'flag' },
	{ name: '--glob-pathspecs', kind: 'flag' },
	{ name: '--noglob-pathspecs', kind: 'flag' },
	{ name: '--icase-pathspecs', kind: 'flag' },
	{ name: '--no-optional-locks', kind: 'flag' }
];
export const GIT_STRUCTURED_SUBCOMMAND_DENIES: { subcommand: string; tools: string }[] = [
	{ subcommand: 'status', tools: 'git_status' },
	{ subcommand: 'diff', tools: 'git_diff' },
	{ subcommand: 'log', tools: 'git_log' },
	{ subcommand: 'show', tools: 'git_show_commit or git_show_file' },
	{ subcommand: 'commit', tools: 'git_commit' }
];

export function riskyGitGlobalOptionFeedback(option: string): string {
	return `Shell \`git ${option}\` is denied because it can change repository, worktree, config, namespace, or execution context. Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit tools where applicable.`;
}

export function gitStructuredSubcommandFeedback(subcommand: string, tools: string): string {
	const toolNoun = tools.includes(' or ') ? 'tools' : 'tool';
	return `Shell \`git ${subcommand}\` is denied. Use ${tools} ${toolNoun}.`;
}
