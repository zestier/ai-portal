import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	shellRuleMatches,
	shellRuleMatchesSegment
} from '../src/lib/server/permissions/predicates/shell';
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
	return shellRuleMatches(rule, parsed.segments, { workspaceRoots: [ws], sessionWorkspaceRoot });
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

describe('shell predicate — deny matching sees short options inside a cluster', () => {
	// A deny-only reader rule shaped like the seeded `sort` one.
	const rule: ShellRule = {
		command: [{ token: 'sort', options: { deny: ['-o', '--output'] } }],
		positionals: { kind: 'workspace-paths' }
	};

	it('rejects a denied short option bundled behind another short option', () => {
		// `-bo/etc/x` is `-b -o /etc/x`: an arbitrary WRITE. A prefix-only deny
		// misses it, and because the matcher does not know `-o` takes a value,
		// the target never becomes a positional either — so nothing else would
		// catch it.
		expect(match(rule, 'sort -bo/etc/passwd')).toBe(false);
		expect(match(rule, 'sort -bo /etc/passwd')).toBe(false);
		// Even bundled at the end, with the value as the next token.
		expect(match(rule, 'sort -rbo out.txt')).toBe(false);
	});

	it('still rejects the plain and attached forms', () => {
		expect(match(rule, 'sort -o /etc/passwd')).toBe(false);
		expect(match(rule, 'sort -o/etc/passwd')).toBe(false);
		expect(match(rule, 'sort --output=/etc/passwd')).toBe(false);
	});

	it('does not treat a long option as a cluster of short options', () => {
		// `--only-…` contains an `o`, but long options are never clusters.
		const longRule: ShellRule = {
			command: [{ token: 'demo', options: { deny: ['-o'] } }],
			positionals: { kind: 'any' }
		};
		expect(match(longRule, 'demo --debug')).toBe(true);
		expect(match(longRule, 'demo --no-color')).toBe(true);
	});

	it('rejects an abbreviated long option, which getopt_long accepts', () => {
		// `sort --out=FILE` is `sort --output=FILE`. Matching only the canonical
		// spelling made the deny a speed bump.
		expect(match(rule, 'sort --out=/etc/passwd')).toBe(false);
		expect(match(rule, 'sort --outp /etc/passwd')).toBe(false);
		expect(match(rule, 'sort --o=/etc/passwd')).toBe(false);
	});

	it('does not deny a longer option that merely starts with a denied name', () => {
		// Over-breadth runs one way only: a token that is a PREFIX OF a denied
		// name is denied, not a token the denied name is a prefix of.
		const grepish: ShellRule = {
			command: [{ token: 'grep', options: { deny: ['-f', '--file'] } }],
			positionals: { kind: 'any' }
		};
		expect(match(grepish, 'grep --files-with-matches x')).toBe(true);
		expect(match(grepish, 'grep --file=pats')).toBe(false);
		expect(match(grepish, 'grep --fil pats')).toBe(false);
	});

	it('leaves undenied clusters alone', () => {
		expect(match(rule, 'sort -rn README.md')).toBe(true);
		expect(match(rule, 'sort README.md')).toBe(true);
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
		expect(shellRuleMatches(rule, parsed.segments, { workspaceRoots: null })).toBe(false);
	});

	it('positionals=session-workspace-paths only accepts paths inside the session workspace', () => {
		const rule = shell(['cat'], { positionals: { kind: 'session-workspace-paths' } });
		expect(match(rule, `cat ${join(ws, 'README.md')}`, ws)).toBe(true);
		expect(match(rule, 'cat /etc/passwd', ws)).toBe(false);
		expect(match(rule, `cat ${join(ws, 'README.md')}`, null)).toBe(false);
	});

	it('positionals=any does not containment-check its operands', () => {
		// Deliberate: an operand that isn't a path (a grep pattern, say) must
		// not be resolved against the workspace. Bound the COUNT to keep such
		// a rule narrow.
		const rule = shell(['grep'], { positionals: { kind: 'any' } });
		expect(match(rule, 'grep ../etc/passwd')).toBe(true);
		expect(match(rule, 'grep "^root:"')).toBe(true);
	});

	it('positionalCount bounds the number of positionals, inclusively', () => {
		const upTo1 = shell(['grep'], { positionalCount: { max: 1 } });
		expect(match(upTo1, 'grep')).toBe(true);
		expect(match(upTo1, 'grep foo')).toBe(true);
		expect(match(upTo1, 'grep foo README.md')).toBe(false);

		const exactly1 = shell(['grep'], { positionalCount: { min: 1, max: 1 } });
		expect(match(exactly1, 'grep')).toBe(false);
		expect(match(exactly1, 'grep foo')).toBe(true);
		expect(match(exactly1, 'grep foo bar')).toBe(false);

		const atLeast2 = shell(['grep'], { positionalCount: { min: 2 } });
		expect(match(atLeast2, 'grep foo')).toBe(false);
		expect(match(atLeast2, 'grep foo bar')).toBe(true);
		expect(match(atLeast2, 'grep foo bar baz')).toBe(true);
	});

	it('positionalCount composes with the containment rule', () => {
		// Exactly one workspace path — inexpressible before the count range
		// was split out from the shape rule.
		const oneWorkspacePath = shell(['cat'], {
			positionals: { kind: 'workspace-paths' },
			positionalCount: { min: 1, max: 1 }
		});
		expect(match(oneWorkspacePath, 'cat README.md')).toBe(true);
		expect(match(oneWorkspacePath, 'cat README.md src/a.ts')).toBe(false);
		expect(match(oneWorkspacePath, 'cat /etc/passwd')).toBe(false);
		expect(match(oneWorkspacePath, 'cat')).toBe(false);
	});

	it('positionalCount is unconstrained on omitted ends and when absent', () => {
		expect(match(shell(['echo']), 'echo a b c d')).toBe(true);
		expect(match(shell(['echo'], { positionalCount: { min: 0 } }), 'echo a b c d')).toBe(true);
	});
});

describe('shell predicate — positionals deferred to the fs grants', () => {
	function matchWithFs(
		rule: ShellRule,
		command: string,
		pathPermitted: ((perm: 'read' | 'write' | 'edit', path: string) => boolean) | undefined,
		explain?: { positionalRefusal?: string }
	): boolean {
		const parsed = parseShellCommand(command);
		if (parsed.kind !== 'parsed') return false;
		const ctx = { workspaceRoots: [ws], sessionWorkspaceRoot: ws, pathPermitted };
		return parsed.segments.every((seg) => shellRuleMatchesSegment(rule, seg, ctx, explain));
	}

	it('accepts a positional the fs predicate permits, even outside the workspace', () => {
		const rule = shell(['cat'], { positionals: { kind: 'readable-paths' } });
		const permitted = (perm: string, p: string) => perm === 'read' && p === '/opt/corpus/a.txt';
		expect(matchWithFs(rule, 'cat /opt/corpus/a.txt', permitted)).toBe(true);
		expect(matchWithFs(rule, 'cat /etc/passwd', permitted)).toBe(false);
	});

	it('asks about `write` for writable-paths', () => {
		const seen: string[] = [];
		const rule = shell(['touch'], { positionals: { kind: 'writable-paths' } });
		matchWithFs(rule, 'touch out.txt', (perm, p) => {
			seen.push(`${perm}:${p}`);
			return true;
		});
		expect(seen).toEqual(['write:out.txt']);
	});

	it('requires EVERY positional to be permitted', () => {
		const rule = shell(['cat'], { positionals: { kind: 'readable-paths' } });
		const permitted = (_perm: string, p: string) => p === 'ok.txt';
		expect(matchWithFs(rule, 'cat ok.txt', permitted)).toBe(true);
		expect(matchWithFs(rule, 'cat ok.txt nope.txt', permitted)).toBe(false);
	});

	it('accepts a command with no positionals at all', () => {
		const rule = shell(['ls'], { positionals: { kind: 'readable-paths' } });
		expect(matchWithFs(rule, 'ls', () => false)).toBe(true);
	});

	it('fails closed when no fs predicate is supplied', () => {
		const rule = shell(['cat'], { positionals: { kind: 'readable-paths' } });
		expect(matchWithFs(rule, 'cat README.md', undefined)).toBe(false);
		// ...and specifically not because of a workspace boundary: the path is
		// inside the workspace, which `workspace-paths` would have accepted.
		expect(
			match(shell(['cat'], { positionals: { kind: 'workspace-paths' } }), 'cat README.md')
		).toBe(true);
	});

	it('explains the refusal by naming the missing fs permission', () => {
		const rule = shell(['cat'], { positionals: { kind: 'readable-paths' } });
		const explain: { positionalRefusal?: string } = {};
		matchWithFs(rule, 'cat /etc/passwd', () => false, explain);
		expect(explain.positionalRefusal).toContain('/etc/passwd');
		expect(explain.positionalRefusal).toContain('read');
		expect(explain.positionalRefusal).not.toContain('workspace');
	});

	it('explains a missing predicate as an unconsultable grant set', () => {
		const rule = shell(['cat'], { positionals: { kind: 'writable-paths' } });
		const explain: { positionalRefusal?: string } = {};
		matchWithFs(rule, 'cat x', undefined, explain);
		expect(explain.positionalRefusal).toContain('write');
	});

	it('leaves the explanation untouched when the rule matches', () => {
		const rule = shell(['cat'], { positionals: { kind: 'readable-paths' } });
		const explain: { positionalRefusal?: string } = {};
		expect(matchWithFs(rule, 'cat x', () => true, explain)).toBe(true);
		expect(explain.positionalRefusal).toBeUndefined();
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

	it('pipeline=pipe-target only matches segments downstream of a `|`', () => {
		const target = shell(['grep'], { pipeline: 'pipe-target' });
		// Bare grep consumes no pipe.
		expect(match(target, 'grep foo')).toBe(false);
		// Producer side: grep reads files here and merely feeds `head`, so
		// this is exactly the case `must` would wrongly accept.
		expect(match(target, 'grep foo file | head')).toBe(false);
		// Every segment must match, and the first grep is a producer.
		expect(match(target, 'grep a | grep b')).toBe(false);
		// `&&` is not a pipe.
		expect(match(target, 'cat a && grep b')).toBe(false);
	});

	it('pipeline=pipe-target matches the filter position of a real pipeline', () => {
		// Rules are evaluated per-segment by the matcher, so check the
		// downstream segment on its own the way matchShellSegments does.
		const target = shell(['grep'], { pipeline: 'pipe-target' });
		const parsed = parseShellCommand('cat a | grep b');
		if (parsed.kind !== 'parsed') throw new Error('parse');
		expect(
			shellRuleMatchesSegment(target, parsed.segments[1], {
				workspaceRoots: [ws],
				inPipeline: true,
				isPipeTarget: true
			})
		).toBe(true);
		expect(
			shellRuleMatchesSegment(target, parsed.segments[1], {
				workspaceRoots: [ws],
				inPipeline: true,
				isPipeTarget: false
			})
		).toBe(false);
	});

	it('pipeline=pipe-target fails closed when the caller omits isPipeTarget', () => {
		const target = shell(['grep'], { pipeline: 'pipe-target' });
		const parsed = parseShellCommand('grep b');
		if (parsed.kind !== 'parsed') throw new Error('parse');
		expect(shellRuleMatchesSegment(target, parsed.segments[0], { workspaceRoots: [ws] })).toBe(
			false
		);
	});
});
