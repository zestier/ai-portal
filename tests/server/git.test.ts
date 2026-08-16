import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	mkdirSync,
	chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../../src/lib/server/git';
import { buildGitTools } from '../../src/lib/server/tools/git';
import { COMMIT_TICKET_FOLLOW_UP_HINT } from '../../src/lib/server/tools/follow-up-hints';

let repo: string;
let firstSha = '';

function g(args: string[], cwd = repo) {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(prefix = 'gitwrap-commit-') {
	const tmp = mkdtempSync(join(tmpdir(), prefix));
	const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
	run(['init', '-q', '-b', 'main']);
	run(['config', 'user.email', 't@example.com']);
	run(['config', 'user.name', 'T']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(tmp, 'a.txt'), 'one\n');
	writeFileSync(join(tmp, 'b.txt'), 'two\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init']);
	return { tmp, run };
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'gitwrap-'));
	g(['init', '-q', '-b', 'main']);
	g(['config', 'user.email', 'test@example.com']);
	g(['config', 'user.name', 'Test']);
	g(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(repo, 'a.txt'), 'hello\n');
	mkdirSync(join(repo, 'sub'));
	writeFileSync(join(repo, 'sub', 'b.txt'), 'one\ntwo\n');
	g(['add', '.']);
	g(['commit', '-q', '-m', 'initial']);
	firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
	// Make some changes for status/diff tests.
	writeFileSync(join(repo, 'a.txt'), 'hello\nchanged\n');
	writeFileSync(join(repo, 'new.txt'), 'fresh\n');
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('isGitRepo / headInfo', () => {
	it('detects a repo', async () => {
		expect(await git.isGitRepo(repo)).toBe(true);
	});
	it('reports branch + sha + dirtyCount', async () => {
		const info = await git.headInfo(repo);
		expect(info.initialized).toBe(true);
		if (info.initialized) {
			expect(info.branch).toBe('main');
			expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(info.dirtyCount).toBeGreaterThanOrEqual(2);
		}
	});
	it('non-repo returns initialized:false', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'norepo-'));
		try {
			const info = await git.headInfo(tmp);
			expect(info.initialized).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('status', () => {
	it('reports modified + untracked entries', async () => {
		const entries = await git.status(repo);
		const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
		expect(byPath['a.txt']?.worktree).toBe('modified');
		expect(byPath['new.txt']?.worktree).toBe('untracked');
	});
});

describe('discardAllLocalChanges', () => {
	it('resets tracked changes and removes untracked files without removing ignored files', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-discard-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, '.gitignore'), 'ignored.txt\n');
			writeFileSync(join(tmp, 'tracked.txt'), 'original\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);

			writeFileSync(join(tmp, 'tracked.txt'), 'changed\n');
			writeFileSync(join(tmp, 'staged.txt'), 'staged\n');
			run(['add', 'staged.txt']);
			writeFileSync(join(tmp, 'untracked.txt'), 'untracked\n');
			writeFileSync(join(tmp, 'ignored.txt'), 'ignored\n');

			await git.discardAllLocalChanges(tmp);

			expect(readFileSync(join(tmp, 'tracked.txt'), 'utf8')).toBe('original\n');
			expect(existsSync(join(tmp, 'staged.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'untracked.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'ignored.txt'))).toBe(true);
			expect(await git.status(tmp)).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('removes staged and unstaged files from repositories without commits', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-discard-unborn-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			writeFileSync(join(tmp, 'staged.txt'), 'staged\n');
			run(['add', 'staged.txt']);
			writeFileSync(join(tmp, 'untracked.txt'), 'untracked\n');

			await git.discardAllLocalChanges(tmp);

			expect(existsSync(join(tmp, 'staged.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'untracked.txt'))).toBe(false);
			expect(await git.status(tmp)).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('log', () => {
	it('returns recent commits', async () => {
		const entries = await git.log(repo, { limit: 5 });
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries[0].subject).toBe('initial');
		expect(entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
		expect(entries[0].sha).toBe(entries[0].sha.trim());
	});

	it('filters history by workspace path', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-log-path-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			mkdirSync(join(tmp, 'sub'));
			writeFileSync(join(tmp, 'sub', 'b.txt'), 'one\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'add b']);
			writeFileSync(join(tmp, 'a.txt'), 'two\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'add a']);

			const entries = await git.log(tmp, { limit: 5, path: 'sub/b.txt' });
			expect(entries.map((e) => e.subject)).toEqual(['add b']);
			expect(entries[0].sha).toBe(entries[0].sha.trim());
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('rejects invalid refs and path escapes', async () => {
		await expect(git.log(repo, { ref: '--all' })).rejects.toThrow('invalid ref');
		await expect(git.log(repo, { path: '../escape' })).rejects.toThrow('invalid path');
	});

	it('rejects stash/reflog refs', async () => {
		await expect(git.log(repo, { ref: 'stash@{0}' })).rejects.toThrow('invalid ref');
		await expect(git.log(repo, { ref: '@{upstream}' })).rejects.toThrow('invalid ref');
		await expect(git.log(repo, { ref: 'refs/stash' })).rejects.toThrow('invalid ref');
	});

	it('still allows ordinary branch names that merely end in "stash"', async () => {
		g(['branch', 'feature/stash']);
		try {
			const entries = await git.log(repo, { ref: 'feature/stash', limit: 1 });
			expect(entries[0].subject).toBe('initial');
		} finally {
			g(['branch', '-D', 'feature/stash']);
		}
	});
});

describe('diff', () => {
	it('diffs worktree vs HEAD', async () => {
		const d = await git.diff(repo, { kind: 'worktree-vs-head' });
		expect(d).toContain('a.txt');
		expect(d).toContain('+changed');
	});
	it('diffs single file', async () => {
		const d = await git.diff(repo, { kind: 'worktree-vs-head' }, 'a.txt');
		expect(d).toContain('a.txt');
		expect(d).not.toMatch(/diff --git a\/new\.txt/);
	});
	it('rejects path escape', async () => {
		await expect(git.diff(repo, { kind: 'worktree-vs-head' }, '../escape')).rejects.toThrow();
	});

	it('returns structured stat and path-filtered name outputs', async () => {
		const stat = await git.diffStat(repo, { kind: 'worktree-vs-head' });
		expect(stat.total).toEqual({ filesChanged: 1, added: 1, removed: 0 });
		expect(stat.files[0]).toMatchObject({ path: 'a.txt', added: 1, removed: 0 });

		await expect(git.nameOnly(repo, { kind: 'worktree-vs-head' }, 'sub/b.txt')).resolves.toEqual(
			[]
		);
		await expect(git.nameOnly(repo, { kind: 'worktree-vs-head' })).resolves.toEqual(['a.txt']);
		await expect(git.nameStatus(repo, { kind: 'worktree-vs-head' })).resolves.toEqual([
			{ statusCode: 'M', status: 'modified', path: 'a.txt', origPath: null }
		]);
	});
});

describe('showCommit / showFile', () => {
	it('returns commit detail and file list', async () => {
		const c = await git.showCommit(repo, firstSha);
		expect(c.subject).toBe('initial');
		const paths = c.files.map((f) => f.path).sort();
		expect(paths).toContain('a.txt');
		expect(paths).toContain('sub/b.txt');
	});
	it('reads file at revision', async () => {
		const out = await git.showFile(repo, firstSha, 'a.txt');
		expect(out).toBe('hello\n');
	});
	it('reads the correct blob when the workdir is a subdirectory', async () => {
		// `git show <ref>:<path>` resolves <path> relative to the repo root, so
		// a subdir workdir must have its path rebased onto the repo root.
		const out = await git.showFile(join(repo, 'sub'), firstSha, 'b.txt');
		expect(out).toBe('one\ntwo\n');
	});
	it('rejects stash/reflog refs', async () => {
		await expect(git.showFile(repo, 'stash@{0}', 'a.txt')).rejects.toThrow('invalid ref');
		await expect(git.showFile(repo, 'refs/stash', 'a.txt')).rejects.toThrow('invalid ref');
		await expect(git.showFile(repo, '@{-1}', 'a.txt')).rejects.toThrow('invalid ref');
	});
	it('rejects invalid sha', async () => {
		await expect(git.showCommit(repo, 'not-a-sha!!')).rejects.toThrow();
	});
	it('optionally includes a commit patch', async () => {
		const c = await git.showCommit(repo, firstSha, { includePatch: true });
		expect(c.patch).toContain('diff --git');
		expect(c.patch).toContain('a.txt');
	});
});

describe('numstat', () => {
	it('reports added/removed lines per tracked file vs HEAD', async () => {
		const stats = await git.numstat(repo, { kind: 'worktree-vs-head' });
		const byPath = Object.fromEntries(stats.map((s) => [s.path, s]));
		// a.txt: one line added ("changed\n"), zero removed.
		expect(byPath['a.txt']).toBeDefined();
		expect(byPath['a.txt']?.added).toBe(1);
		expect(byPath['a.txt']?.removed).toBe(0);
		// new.txt is untracked so it does not appear in diff vs HEAD.
		expect(byPath['new.txt']).toBeUndefined();
	});

	it('handles renames as a single entry with origPath', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-rename-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, 'old.txt'), 'one\ntwo\nthree\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);
			run(['mv', 'old.txt', 'new.txt']);
			writeFileSync(join(tmp, 'new.txt'), 'one\ntwo\nthree\nfour\n');
			const stats = await git.numstat(tmp, { kind: 'worktree-vs-head' });
			const rename = stats.find((s) => s.path === 'new.txt');
			expect(rename).toBeDefined();
			expect(rename?.origPath).toBe('old.txt');
			expect(rename?.added).toBe(1);
			expect(rename?.removed).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('reports null counts for binary files', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-bin-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, 'data.bin'), Buffer.from([0, 1, 2, 0, 0, 3]));
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);
			writeFileSync(join(tmp, 'data.bin'), Buffer.from([0, 0, 0, 0, 0, 4, 5]));
			const stats = await git.numstat(tmp, { kind: 'worktree-vs-head' });
			const bin = stats.find((s) => s.path === 'data.bin');
			expect(bin).toBeDefined();
			expect(bin?.added).toBeNull();
			expect(bin?.removed).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('structured git tools', () => {
	it('returns JSON for non-patch git_diff outputs', async () => {
		const tool = buildGitTools(repo).find((t) => t.name === 'git_diff');
		expect(tool).toBeDefined();

		const out = await tool!.handler({ output: 'name-status' });
		expect(out.ok).toBe(true);
		expect(out.ok && out.result).toEqual({
			files: [{ statusCode: 'M', status: 'modified', path: 'a.txt', origPath: null }]
		});
	});

	it('rejects unknown structured git tool properties', async () => {
		const tool = buildGitTools(repo).find((t) => t.name === 'git_log');
		expect(tool).toBeDefined();

		await expect(tool!.handler({ limit: 1, flags: ['--all'] })).rejects.toThrow('Unrecognized key');
	});

	it('wires git_commit as an always-prompt structured tool', async () => {
		const tool = buildGitTools(repo).find((t) => t.name === 'git_commit');
		expect(tool).toBeDefined();
		expect(tool?.permissionBehavior).toBe('always-prompt');
		await expect(tool!.handler({ paths: [], subject: 'empty' })).rejects.toThrow();
		await expect(tool!.handler({ paths: 'all', subject: 'bad\nsubject' })).rejects.toThrow();
		await expect(
			tool!.handler({ paths: 'all', subject: 'ok', trailers: [{ token: 'Bad Token', value: 'x' }] })
		).rejects.toThrow();
	});

	it('sets the verbatim followUpHint on a successful git_commit envelope', async () => {
		// Pin the exact wording the ticket mandates so a typo in the shared
		// constant can't silently change the agent-visible nudge.
		expect(COMMIT_TICKET_FOLLOW_UP_HINT).toBe(
			'Now reconcile workspace tickets: review the open ones with ticket_list and, for any that this commit completes or advances, update them with ticket_update.'
		);
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const tool = buildGitTools(tmp).find((t) => t.name === 'git_commit');
			expect(tool).toBeDefined();
			const out = await tool!.handler({ paths: 'all', subject: 'commit all' });
			expect(out.ok).toBe(true);
			expect(out.ok && out.followUpHint).toBe(COMMIT_TICKET_FOLLOW_UP_HINT);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('commitChanges', () => {
	it('rejects path escapes and no-change commits', async () => {
		const { tmp } = initRepo();
		try {
			await expect(
				git.commitChanges(tmp, { paths: ['../escape.txt'], subject: 'escape' })
			).rejects.toThrow('invalid path');
			await expect(git.commitChanges(tmp, { paths: 'all', subject: 'noop' })).rejects.toThrow(
				'no selected changes'
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('commits all tracked, deleted, and untracked changes', async () => {
		const { tmp, run } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			rmSync(join(tmp, 'b.txt'));
			writeFileSync(join(tmp, 'new.txt'), 'new\n');

			const result = await git.commitChanges(tmp, { paths: 'all', subject: 'commit all' });
			expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(result.shortSha).toHaveLength(8);
			expect(result.subject).toBe('commit all');
			expect(result.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
			expect(result.diffStat.filesChanged).toBe(3);
			expect(result.remainingDirtyFiles).toEqual([]);
			expect(execFileSync('git', ['status', '--porcelain'], { cwd: tmp }).toString()).toBe('');
			expect(
				execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: tmp }).toString().trim()
			).toBe('commit all');
			run(['rev-parse', '--verify', 'HEAD']);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('commits only explicitly selected tracked paths', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nselected\n');
			writeFileSync(join(tmp, 'b.txt'), 'two\nleft dirty\n');

			const result = await git.commitChanges(tmp, { paths: ['a.txt'], subject: 'commit a' });
			expect(result.files.map((f) => f.path)).toEqual(['a.txt']);
			expect(result.remainingDirtyFiles.map((f) => f.path)).toEqual(['b.txt']);
			expect(
				execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: tmp })
					.toString()
					.trim()
			).toBe('a.txt');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('commits explicitly selected untracked files', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'new.txt'), 'new\n');

			const result = await git.commitChanges(tmp, {
				paths: ['new.txt'],
				subject: 'add new file'
			});
			expect(result.files).toEqual([
				{ statusCode: 'A', status: 'added', path: 'new.txt', origPath: null }
			]);
			expect(result.remainingDirtyFiles).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('treats explicitly selected paths as literal filenames, not git globs', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, '*.txt'), 'literal star\n');
			writeFileSync(join(tmp, 'a.txt'), 'one\nleft dirty\n');

			const result = await git.commitChanges(tmp, {
				paths: ['*.txt'],
				subject: 'add literal wildcard'
			});

			expect(result.files).toEqual([
				{ statusCode: 'A', status: 'added', path: '*.txt', origPath: null }
			]);
			expect(result.remainingDirtyFiles.map((f) => f.path)).toEqual(['a.txt']);
			expect(
				execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: tmp })
					.toString()
					.trim()
			).toBe('*.txt');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('rejects selected commits when unrelated staged changes exist', async () => {
		const { tmp, run } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nselected\n');
			writeFileSync(join(tmp, 'b.txt'), 'two\nstaged\n');
			run(['add', 'b.txt']);
			const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim();

			await expect(
				git.commitChanges(tmp, { paths: ['a.txt'], subject: 'commit a' })
			).rejects.toThrow('unrelated changes are staged');
			expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim()).toBe(
				before
			);
			expect(execFileSync('git', ['status', '--porcelain'], { cwd: tmp }).toString()).toBe(
				' M a.txt\nM  b.txt\n'
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('formats body and structured trailers deterministically', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');

			const result = await git.commitChanges(tmp, {
				paths: ['a.txt'],
				subject: 'structured message',
				body: 'Body line\n',
				trailers: [{ token: 'Reviewed-by', value: 'Tester <t@example.com>' }]
			});
			expect(result.body).toBe('Body line');
			expect(result.trailers).toEqual([{ token: 'Reviewed-by', value: 'Tester <t@example.com>' }]);
			expect(execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: tmp }).toString()).toBe(
				'structured message\n\nBody line\n\nReviewed-by: Tester <t@example.com>\n\n'
			);
			expect(() =>
				git.formatCommitMessage({
					subject: 'bad trailer',
					trailers: [{ token: 'Bad Token', value: 'x' }]
				})
			).toThrow('invalid trailer token');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('rejects C1 control characters and ANSI escapes in the subject', () => {
		// NEL (U+0085) could forge an extra commit line; ESC drives ANSI
		// sequences in terminal `git log` viewers.
		expect(() => git.formatCommitMessage({ subject: 'line\u0085forged' })).toThrow(
			'control characters'
		);
		expect(() => git.formatCommitMessage({ subject: 'clear\u001b[2Jscreen' })).toThrow(
			'control characters'
		);
	});

	it('rejects control characters in the body but allows ordinary whitespace', () => {
		expect(() => git.formatCommitMessage({ subject: 'ok', body: 'nel\u0085here' })).toThrow(
			'control characters'
		);
		expect(() => git.formatCommitMessage({ subject: 'ok', body: 'ansi\u001b[31mred' })).toThrow(
			'control characters'
		);
		expect(() => git.formatCommitMessage({ subject: 'ok', body: 'NUL\u0000here' })).toThrow(
			'control characters'
		);
		// Newlines and tabs remain valid in a body.
		expect(() =>
			git.formatCommitMessage({ subject: 'ok', body: 'first line\n\tindented\n' })
		).not.toThrow();
	});
});

describe('commitChanges streaming context', () => {
	function installHook(tmp: string, name: string, body: string) {
		const hooksDir = join(tmp, '.git', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		const p = join(hooksDir, name);
		writeFileSync(p, body, { mode: 0o755 });
		chmodSync(p, 0o755);
	}

	it('emits coarse progress around staging, commit, and finalize', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const progress: string[] = [];
			const result = await git.commitChanges(
				tmp,
				{ paths: 'all', subject: 'progress test' },
				{ progress: (m) => progress.push(m) }
			);
			expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(progress).toEqual([
				'staging changes…',
				'running git commit (pre-commit / commit-msg hooks)…',
				'finalizing commit…'
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('streams cumulative (replace-not-append) hook output via partial snapshots', async () => {
		const { tmp } = initRepo();
		try {
			installHook(tmp, 'pre-commit', '#!/bin/sh\necho "hook line 1"\necho "hook line 2"\nexit 0\n');
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const snaps: string[] = [];
			const result = await git.commitChanges(
				tmp,
				{ paths: 'all', subject: 'hook stream' },
				{ partial: (s) => snaps.push(s) }
			);
			expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(snaps.length).toBeGreaterThan(0);
			// Each snapshot is a prefix of the next: the client replaces, never appends.
			for (let i = 1; i < snaps.length; i++) {
				expect(snaps[i].startsWith(snaps[i - 1])).toBe(true);
			}
			const final = snaps[snaps.length - 1];
			expect(final).toContain('hook line 1');
			expect(final).toContain('hook line 2');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('SIGKILLs the commit child on abort and rejects without committing', async () => {
		const { tmp } = initRepo();
		try {
			installHook(tmp, 'pre-commit', '#!/bin/sh\nsleep 5\nexit 0\n');
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim();
			const snaps: string[] = [];
			const ac = new AbortController();
			const start = Date.now();
			setTimeout(() => ac.abort(), 200);
			await expect(
				git.commitChanges(
					tmp,
					{ paths: 'all', subject: 'aborted' },
					{ signal: ac.signal, partial: (s) => snaps.push(s) }
				)
			).rejects.toThrow();
			const elapsed = Date.now() - start;
			// The 5s hook sleep would otherwise dominate; a kill returns promptly.
			expect(elapsed).toBeLessThan(4000);
			// No commit landed and the index was restored (a.txt is dirty again).
			expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim()).toBe(
				before
			);
			expect(execFileSync('git', ['status', '--porcelain'], { cwd: tmp }).toString()).toContain(
				'a.txt'
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('leaves non-streaming git calls unaffected (no onData/signal)', async () => {
		const { tmp } = initRepo();
		try {
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			// No ctx at all: behaves exactly like before, fully buffered.
			const result = await git.commitChanges(tmp, { paths: 'all', subject: 'no ctx' });
			expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(result.subject).toBe('no ctx');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('bounds the error message from a verbose failing pre-commit hook', async () => {
		const { tmp } = initRepo();
		try {
			installHook(
				tmp,
				'pre-commit',
				'#!/bin/sh\ni=0\nwhile [ $i -lt 3000 ]; do echo "hook error line $i"; i=$((i+1)); done\nexit 1\n'
			);
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const err = await git.commitChanges(tmp, { paths: 'all', subject: 'x' }).catch((e) => e);
			expect(err).toBeInstanceOf(git.GitError);
			const message = (err as git.GitError).message;
			expect(message.length).toBeLessThan(16_000);
			expect(message).toMatch(/hook error line 2999$/);
			expect(message).toContain('bytes of stderr omitted — showing tail');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('small git error stderr is passed through unmodified', async () => {
		const { tmp } = initRepo();
		try {
			installHook(
				tmp,
				'pre-commit',
				'#!/bin/sh\necho "small line 1"\necho "small line 2"\necho "small line 3"\nexit 1\n'
			);
			writeFileSync(join(tmp, 'a.txt'), 'one\nchanged\n');
			const err = await git.commitChanges(tmp, { paths: 'all', subject: 'x' }).catch((e) => e);
			expect(err).toBeInstanceOf(git.GitError);
			const message = (err as git.GitError).message;
			expect(message).toContain('small line 1');
			expect(message).toContain('small line 2');
			expect(message).toContain('small line 3');
			expect(message).not.toContain('omitted');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
