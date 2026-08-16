import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalWorkspaceRoot } from '../../../src/lib/server/permissions/repo-root';

function git(args: string[], cwd: string): void {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): { base: string; main: string; wt: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-root-repo-')));
	const main = join(base, 'main');
	const wt = join(base, 'wt');
	mkdirSync(main);
	git(['init', '-q', '-b', 'main'], main);
	git(['config', 'user.email', 'portal-test@localhost'], main);
	git(['config', 'user.name', 'Portal Test'], main);
	writeFileSync(join(main, 'a.txt'), 'x');
	git(['add', 'a.txt'], main);
	git(['commit', '-q', '-m', 'base'], main);
	git(['worktree', 'add', '-q', '-b', 'wt-branch', wt, 'HEAD'], main);
	return { base, main, wt };
}

describe('canonicalWorkspaceRoot', () => {
	it('unifies a repo main checkout and a linked worktree', () => {
		const { base, main, wt } = makeRepo();
		try {
			expect(canonicalWorkspaceRoot(main)).toBe(realpathSync(main));
			expect(canonicalWorkspaceRoot(wt)).toBe(realpathSync(main));
			expect(canonicalWorkspaceRoot(main)).toBe(canonicalWorkspaceRoot(wt));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('falls back to realpath for a non-git dir', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'portal-root-nongit-')));
		try {
			expect(canonicalWorkspaceRoot(dir)).toBe(realpathSync(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('leaves a non-existent root as its resolve()d path', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'portal-root-missing-')));
		try {
			const missing = join(dir, 'nope');
			expect(canonicalWorkspaceRoot(missing)).toBe(missing);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
