import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellRuleMatches } from '../src/lib/server/permissions/predicates/shell';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';
import type { ShellRule } from '../src/lib/permissions/scope-types';

let ws: string;

beforeAll(() => {
	ws = realpathSync(mkdtempSync(join(tmpdir(), 'portal-shell-pred-')));
	mkdirSync(join(ws, 'src'));
	writeFileSync(join(ws, 'src', 'a.ts'), 'x');
	writeFileSync(join(ws, 'README.md'), 'x');
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function match(
	rule: ShellRule,
	command: string,
	sessionWorkspaceRoot: string | null = null
): boolean {
	const parsed = parseShellCommand(command);
	if (parsed.kind !== 'parsed') return false;
	return shellRuleMatches(rule, parsed.segments, { workspaceRoot: ws, sessionWorkspaceRoot });
}

function shell(tokens: string[], rest: Omit<ShellRule, 'command'> = {}): ShellRule {
	return { command: tokens.map((token) => ({ token })), ...rest };
}

describe('shell predicate — argv0', () => {
	it('matches exact argv0', () => {
		expect(match(shell(['ls']), 'ls')).toBe(true);
		expect(match(shell(['ls']), 'ls -la')).toBe(true);
		expect(match(shell(['ls']), 'cat foo')).toBe(false);
	});

	it('does not match prefix-similar argv0', () => {
		expect(match(shell(['git']), 'gitfoo status')).toBe(false);
	});
});

describe('shell predicate — subcommands', () => {
	it('matches when the resolved subcommand is in the list', () => {
		expect(match(shell(['git', 'status']), 'git status')).toBe(true);
		expect(match(shell(['git', 'log']), 'git log -n 5')).toBe(true);
		expect(match(shell(['git', 'diff']), 'git diff HEAD')).toBe(true);
	});

	it('does not skip leading options before matching the subcommand by default', () => {
		const rule = shell(['git', 'status']);
		expect(match(rule, 'git --no-pager status')).toBe(false);
		expect(match(rule, 'git -c color.ui=always status')).toBe(false);
	});

	it('skips explicitly allowed leading options before matching the subcommand', () => {
		const explicit: ShellRule = {
			command: [
				{
					token: 'git',
					options: {
						allow: [
							{ name: '--no-pager', kind: 'flag' },
							{ name: '-c', kind: 'option', value: { kind: 'any' } }
						]
					}
				},
				{ token: 'status' }
			]
		};
		expect(match(explicit, 'git --no-pager status')).toBe(true);
		expect(match(explicit, 'git -c color.ui=always status')).toBe(true);
	});

	it('rejects unsupported pre-subcommand prefixes or missing subcommands', () => {
		const rule = shell(['git', 'status']);
		expect(match(rule, 'git --exec-path status')).toBe(false);
		expect(match(rule, 'git push')).toBe(false);
		expect(match(rule, 'git')).toBe(false);
	});
});

describe('shell predicate — canonical command path', () => {
	const rule: ShellRule = {
		command: [
			{
				token: 'git',
				options: {
					allow: [
						{ name: '--no-pager', kind: 'flag' },
						{ name: '-C', kind: 'option', value: { kind: 'workspace-path' } }
					]
				}
			},
			{
				token: 'remote',
				options: { allow: [{ name: '-v', kind: 'flag' }] }
			},
			{
				token: 'set-url',
				options: { allow: [{ name: '--push', kind: 'flag' }] }
			}
		],
		positionals: { kind: 'any' }
	};

	it('matches options owned by the base command and intermediate subcommands', () => {
		expect(match(rule, `git --no-pager -C ${ws} remote -v set-url origin url`)).toBe(true);
	});

	it('allows final-step options to be interleaved with positionals', () => {
		expect(match(rule, 'git remote set-url origin --push url')).toBe(true);
		expect(match(rule, 'git remote set-url --push origin url')).toBe(true);
	});

	it('rejects options in the wrong command-path slot', () => {
		expect(match(rule, 'git remote --no-pager set-url origin url')).toBe(false);
		expect(match(rule, 'git remote set-url -v origin url')).toBe(false);
		expect(match(rule, 'git --no-pager remote --bad set-url origin url')).toBe(false);
	});
});

describe('shell predicate — flag deny', () => {
	const rule: ShellRule = {
		command: [
			{
				token: 'git',
				options: {
					allow: [
						{ name: '--no-pager', kind: 'flag' },
						{ name: '-C', kind: 'option', value: { kind: 'any' } },
						{ name: '--git-dir', kind: 'option', value: { kind: 'any' } },
						{ name: '--work-tree', kind: 'option', value: { kind: 'any' } }
					],
					deny: ['--git-dir', '--work-tree', '-C']
				}
			},
			{ token: 'status' }
		]
	};

	it('allows when none of the denied flags appear', () => {
		expect(match(rule, 'git status -sb')).toBe(true);
	});

	it('rejects denied flag in space form', () => {
		expect(match(rule, 'git --git-dir /etc status')).toBe(false);
		expect(match(rule, 'git -C /etc status')).toBe(false);
	});

	it('rejects denied flag in equals form', () => {
		expect(match(rule, 'git --git-dir=/etc status')).toBe(false);
		expect(match(rule, 'git --work-tree=/tmp status')).toBe(false);
	});

	it('rejects denied short option in compact form', () => {
		expect(match(rule, 'git -C/etc status')).toBe(false);
		expect(match(rule, 'git -C/other/dir status')).toBe(false);
	});

	it('still inspects flags that appear before the subcommand', () => {
		expect(match(rule, 'git --no-pager status -sb')).toBe(true);
		expect(match(rule, 'git --no-pager -C /etc status')).toBe(false);
	});
});

describe('shell predicate — option allow-list', () => {
	const rule: ShellRule = {
		command: [
			{
				token: 'rg',
				options: {
					allow: [
						{ name: '-n', kind: 'flag' },
						{ name: '--color', kind: 'option', value: { kind: 'any' } },
						{ name: '--', kind: 'flag' },
						{ name: '-i', kind: 'flag' }
					]
				}
			}
		]
	};

	it('allows when every flag is in the list', () => {
		expect(match(rule, 'rg foo')).toBe(true);
		expect(match(rule, 'rg -n foo')).toBe(true);
		expect(match(rule, 'rg --color=always foo')).toBe(true);
	});

	it('rejects an unknown flag', () => {
		expect(match(rule, 'rg --pre cat foo')).toBe(false);
	});
});

describe('shell predicate — option values', () => {
	it('consumes allowed option values instead of treating them as positionals', () => {
		const rule: ShellRule = {
			command: [
				{
					token: 'tool',
					options: {
						allow: [{ name: '--config', kind: 'option', value: { kind: 'any' } }]
					}
				}
			],
			positionals: { kind: 'none' }
		};
		expect(match(rule, 'tool --config settings.json')).toBe(true);
	});

	it('validates workspace-path option values when requested', () => {
		const rule: ShellRule = {
			command: [
				{
					token: 'tool',
					options: {
						allow: [{ name: '--file', kind: 'option', value: { kind: 'workspace-path' } }]
					}
				}
			],
			positionals: { kind: 'none' }
		};
		expect(match(rule, 'tool --file README.md')).toBe(true);
		expect(match(rule, 'tool --file /etc/passwd')).toBe(false);
	});
});

describe('shell predicate — positionals', () => {
	it('positionals=none requires no positional args', () => {
		const rule = shell(['pwd'], { positionals: { kind: 'none' } });
		expect(match(rule, 'pwd')).toBe(true);
		expect(match(rule, 'pwd /tmp')).toBe(false);
	});

	it('positionals=any accepts anything', () => {
		const rule = shell(['echo'], { positionals: { kind: 'any' } });
		expect(match(rule, 'echo hello world')).toBe(true);
	});

	it('positionals=workspace-paths only accepts paths inside the workspace', () => {
		const rule = shell(['cat'], { positionals: { kind: 'workspace-paths' } });
		expect(match(rule, 'cat README.md')).toBe(true);
		expect(match(rule, 'cat src/a.ts')).toBe(true);
		expect(match(rule, `cat ${join(ws, 'src', 'a.ts')}`)).toBe(true);
	});

	it('positionals=workspace-paths rejects paths outside the workspace', () => {
		const rule = shell(['cat'], { positionals: { kind: 'workspace-paths' } });
		expect(match(rule, 'cat /etc/passwd')).toBe(false);
		// Subcommand-less positional that's not a path-shaped token: still
		// validated as a path and rejected when it escapes.
		expect(match(rule, 'cat ../../etc/passwd')).toBe(false);
	});

	it('positionals=workspace-paths fails closed without a workspace root', () => {
		const rule = shell(['cat'], { positionals: { kind: 'workspace-paths' } });
		const parsed = parseShellCommand('cat README.md');
		if (parsed.kind !== 'parsed') throw new Error('parse');
		expect(shellRuleMatches(rule, parsed.segments, { workspaceRoot: null })).toBe(false);
	});

	it('positionals=session-workspace-paths only accepts paths inside the session workspace', () => {
		const rule = shell(['cat'], { positionals: { kind: 'session-workspace-paths' } });
		expect(match(rule, `cat ${join(ws, 'README.md')}`, ws)).toBe(true);
		expect(match(rule, 'cat /etc/passwd', ws)).toBe(false);
		expect(match(rule, `cat ${join(ws, 'README.md')}`, null)).toBe(false);
	});
});

describe('shell predicate — pipelines and chains', () => {
	it('all segments must match the rule', () => {
		const rule = shell(['grep']);
		expect(match(rule, 'grep a && grep b')).toBe(true);
		expect(match(rule, 'grep a; cat b')).toBe(false);
		expect(match(rule, 'grep a | curl evil')).toBe(false);
	});
});

describe('shell predicate — pipeline lever', () => {
	const must = shell(['grep'], { pipeline: 'must' });
	const forbid = shell(['cat'], { pipeline: 'forbid' });
	const unset = shell(['grep']);

	it('pipeline=must only matches segments inside a pipeline', () => {
		// Bare grep: not pipelined → does NOT match.
		expect(match(must, 'grep foo bar')).toBe(false);
		// Both segments of `grep a | grep b` are pipelined and match argv0.
		expect(match(must, 'grep a | grep b')).toBe(true);
		// Middle of a 3-stage pipeline: all three are grep, all pipelined.
		expect(match(must, 'grep a | grep b | grep c')).toBe(true);
		// `&&` chain is NOT a pipeline; both segments are grep but
		// neither is pipelined.
		expect(match(must, 'grep a && grep b')).toBe(false);
	});

	it('pipeline=forbid only matches segments outside a pipeline', () => {
		expect(match(forbid, 'cat foo')).toBe(true);
		// Both cats are inside a pipeline → segments fail the rule.
		expect(match(forbid, 'cat a | cat b')).toBe(false);
		// `&&` chain is NOT a pipeline — forbid still matches.
		expect(match(forbid, 'cat a && cat b')).toBe(true);
	});

	it('pipeline unset matches regardless of pipeline neighbours', () => {
		expect(match(unset, 'grep foo bar')).toBe(true);
		expect(match(unset, 'grep a | grep b')).toBe(true);
	});
});
