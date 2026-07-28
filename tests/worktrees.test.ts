import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-worktree-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

async function service() {
	return import('../src/lib/server/worktrees');
}

describe('managed worktrees', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-worktrees-test-');
		process.env.WORKTREE_ROOT = join(dataDir, 'managed-worktrees');
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();
	});

	it('creates an isolated branch at the generated owned path', async () => {
		const source = committedRepository();
		const { createManagedWorktree } = await service();
		const metadata = await createManagedWorktree({
			sourceWorkdir: source,
			userId: 'user-1',
			conversationId: '01WORKTREE'
		});

		expect(metadata.path).toBe(join(dataDir, 'managed-worktrees', 'user-1', '01WORKTREE'));
		expect(metadata.branch).toBe('portal/01WORKTREE');
		expect(metadata.baseSha).toBe(git(source, ['rev-parse', 'HEAD']));
		expect(readFileSync(join(metadata.path, 'README.md'), 'utf8')).toBe('base\n');

		writeFileSync(join(metadata.path, 'README.md'), 'isolated\n');
		expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('base\n');
	});

	it('rejects non-repositories and repositories without a commit', async () => {
		const { createManagedWorktree } = await service();
		const plain = makeTmpDir('portal-worktree-plain-');
		await expect(
			createManagedWorktree({ sourceWorkdir: plain, userId: 'u', conversationId: 'PLAIN' })
		).rejects.toMatchObject({ code: 'not_git_repository' });

		const unborn = makeTmpDir('portal-worktree-unborn-');
		git(unborn, ['init', '-q', '-b', 'main']);
		await expect(
			createManagedWorktree({ sourceWorkdir: unborn, userId: 'u', conversationId: 'UNBORN' })
		).rejects.toMatchObject({ code: 'repository_has_no_commits' });
	});

	it('refuses dirty removal unless forced and retains the branch', async () => {
		const source = committedRepository();
		const { createManagedWorktree, removeManagedWorktree } = await service();
		const metadata = await createManagedWorktree({
			sourceWorkdir: source,
			userId: 'user-2',
			conversationId: 'DIRTY'
		});
		writeFileSync(join(metadata.path, 'untracked.txt'), 'keep me\n');

		await expect(removeManagedWorktree(metadata)).rejects.toMatchObject({
			code: 'worktree_dirty'
		});
		expect(existsSync(metadata.path)).toBe(true);

		await removeManagedWorktree(metadata, { force: true });
		expect(existsSync(metadata.path)).toBe(false);
		expect(git(source, ['branch', '--list', metadata.branch])).toContain(metadata.branch);
	});

	it('keeps generated paths contained even when identifiers are invalid', async () => {
		const source = committedRepository();
		const { createManagedWorktree } = await service();
		mkdirSync(join(dataDir, 'managed-worktrees'), { recursive: true });
		await expect(
			createManagedWorktree({
				sourceWorkdir: source,
				userId: '../escape',
				conversationId: 'BAD'
			})
		).rejects.toMatchObject({ code: 'invalid_identifier' });
	});

	it('rejects a symlinked user directory that escapes the worktree root', async () => {
		const source = committedRepository();
		const outside = makeTmpDir('portal-worktree-outside-');
		const root = join(dataDir, 'managed-worktrees');
		mkdirSync(root, { recursive: true });
		symlinkSync(outside, join(root, 'user-3'));
		const { createManagedWorktree } = await service();

		await expect(
			createManagedWorktree({
				sourceWorkdir: source,
				userId: 'user-3',
				conversationId: 'ESCAPE'
			})
		).rejects.toMatchObject({ code: 'invalid_identifier' });
		expect(existsSync(join(outside, 'ESCAPE'))).toBe(false);
	});

	it('does not follow a replacement symlink during forced stale cleanup', async () => {
		const source = committedRepository();
		const outside = makeTmpDir('portal-worktree-force-outside-');
		writeFileSync(join(outside, 'keep.txt'), 'keep\n');
		const { createManagedWorktree, removeManagedWorktree } = await service();
		const metadata = await createManagedWorktree({
			sourceWorkdir: source,
			userId: 'user-4',
			conversationId: 'STALE'
		});
		renameSync(source, `${source}-moved`);
		rmSync(metadata.path, { recursive: true, force: true });
		symlinkSync(outside, metadata.path);

		await expect(
			removeManagedWorktree(metadata, {
				force: true,
				owner: { userId: 'user-4', conversationId: 'STALE' }
			})
		).rejects.toMatchObject({ code: 'worktree_unavailable' });
		expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
	});
});
