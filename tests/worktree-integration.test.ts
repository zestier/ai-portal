import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, contents: string, message: string): void {
	writeFileSync(join(cwd, file), contents);
	git(cwd, ['add', file]);
	git(cwd, ['commit', '-q', '-m', message]);
}

function committedRepository(): string {
	const source = makeTmpDir('portal-integration-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	commit(source, 'README.md', 'base\n', 'initial');
	return source;
}

async function service() {
	return import('../src/lib/server/worktree-integration');
}

describe('worktree integration', () => {
	let dataDir: string;
	let source: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-worktree-integration-');
		process.env.WORKTREE_ROOT = join(dataDir, 'managed-worktrees');
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();
		source = committedRepository();
	});

	async function worktree(conversationId = '01CONV'): Promise<string> {
		const { createManagedWorktree } = await import('../src/lib/server/worktrees');
		const metadata = await createManagedWorktree({
			sourceWorkdir: source,
			userId: 'user-1',
			conversationId
		});
		return metadata.path;
	}

	describe('worktreeIntegrationStatus', () => {
		it('reports the main checkout as not a linked worktree and never unmerged', async () => {
			const { worktreeIntegrationStatus } = await service();
			const status = await worktreeIntegrationStatus(source);
			expect(status.isLinkedWorktree).toBe(false);
			expect(status.branch).toBe('main');
			expect(status.upstreamBranch).toBe('main');
			expect(status.unmerged).toBe(false);
		});

		it('reports a fresh worktree as clean, level with upstream, and merged', async () => {
			const path = await worktree();
			const { worktreeIntegrationStatus } = await service();
			const status = await worktreeIntegrationStatus(path);
			expect(status.isLinkedWorktree).toBe(true);
			expect(status.branch).toBe('portal/01CONV');
			expect(status.upstreamPath).toBe(source);
			expect(status.upstreamBranch).toBe('main');
			expect(status).toMatchObject({ ahead: 0, behind: 0, dirtyCount: 0, unmerged: false });
		});

		it('counts ahead/behind independently and flags unmerged commits', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			commit(source, 'upstream.txt', 'moved on\n', 'upstream commit');
			const { worktreeIntegrationStatus } = await service();
			const status = await worktreeIntegrationStatus(path);
			expect(status).toMatchObject({ ahead: 1, behind: 1, unmerged: true });
		});

		// Uncommitted work is "unmerged" too: it is work the source branch does
		// not have, and deleting the worktree would be the point it is lost.
		it('flags uncommitted changes as unmerged even with no commits', async () => {
			const path = await worktree();
			writeFileSync(join(path, 'scratch.txt'), 'wip\n');
			const { worktreeIntegrationStatus } = await service();
			const status = await worktreeIntegrationStatus(path);
			expect(status).toMatchObject({ ahead: 0, dirtyCount: 1, unmerged: true });
		});

		it('rejects a non-repository', async () => {
			const { worktreeIntegrationStatus } = await service();
			await expect(worktreeIntegrationStatus(makeTmpDir('portal-plain-'))).rejects.toMatchObject({
				code: 'not_git_repository'
			});
		});
	});

	describe('mergeWorktree to-source', () => {
		it('fast-forwards the source checkout and clears the unmerged flag', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			const { mergeWorktree } = await service();
			const result = await mergeWorktree(path, { direction: 'to-source' });

			expect(result).toMatchObject({ merged: true, fastForward: true, into: 'main' });
			expect(readFileSync(join(source, 'feature.txt'), 'utf8')).toBe('work\n');
			expect(result.status.unmerged).toBe(false);
			expect(result.status.ahead).toBe(0);
		});

		it('is a no-op when there is nothing to integrate', async () => {
			const path = await worktree();
			const { mergeWorktree } = await service();
			const result = await mergeWorktree(path, { direction: 'to-source' });
			expect(result.merged).toBe(false);
		});

		it('refuses when the worktree has uncommitted changes', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			writeFileSync(join(path, 'scratch.txt'), 'wip\n');
			const { mergeWorktree } = await service();
			await expect(mergeWorktree(path, { direction: 'to-source' })).rejects.toMatchObject({
				code: 'worktree_dirty'
			});
		});

		it('refuses when the source checkout has uncommitted changes', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			writeFileSync(join(source, 'README.md'), 'edited in place\n');
			const { mergeWorktree } = await service();
			await expect(mergeWorktree(path, { direction: 'to-source' })).rejects.toMatchObject({
				code: 'upstream_dirty'
			});
			expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('edited in place\n');
		});

		it('refuses a non-fast-forward integration and points at the sync direction', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			commit(source, 'upstream.txt', 'moved on\n', 'upstream commit');
			const { mergeWorktree } = await service();
			await expect(mergeWorktree(path, { direction: 'to-source' })).rejects.toMatchObject({
				code: 'not_fast_forwardable',
				detail: { ahead: 1, behind: 1 }
			});
		});

		it('creates a merge commit when explicitly allowed', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			commit(source, 'upstream.txt', 'moved on\n', 'upstream commit');
			const { mergeWorktree } = await service();
			const result = await mergeWorktree(path, {
				direction: 'to-source',
				allowMergeCommit: true
			});
			expect(result).toMatchObject({ merged: true, fastForward: false });
			expect(readFileSync(join(source, 'feature.txt'), 'utf8')).toBe('work\n');
			expect(readFileSync(join(source, 'upstream.txt'), 'utf8')).toBe('moved on\n');
		});

		// The shared checkout must never be left mid-merge, whatever onConflict says.
		it('rolls the source checkout back on conflict', async () => {
			const path = await worktree();
			commit(path, 'README.md', 'from worktree\n', 'worktree edit');
			commit(source, 'README.md', 'from source\n', 'source edit');
			const { mergeWorktree } = await service();
			await expect(
				mergeWorktree(path, {
					direction: 'to-source',
					allowMergeCommit: true,
					onConflict: 'keep'
				})
			).rejects.toMatchObject({ code: 'merge_conflict', detail: { conflicts: ['README.md'] } });
			expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('from source\n');
			expect(git(source, ['status', '--porcelain=v1'])).toBe('');
		});

		it('refuses when run against the main checkout', async () => {
			const { mergeWorktree } = await service();
			await expect(mergeWorktree(source, { direction: 'to-source' })).rejects.toMatchObject({
				code: 'not_a_worktree'
			});
		});
	});

	describe('mergeWorktree from-source', () => {
		it('pulls upstream commits into the worktree', async () => {
			const path = await worktree();
			commit(source, 'upstream.txt', 'moved on\n', 'upstream commit');
			const { mergeWorktree } = await service();
			const result = await mergeWorktree(path, { direction: 'from-source' });
			expect(result).toMatchObject({ merged: true, into: 'portal/01CONV', from: 'main' });
			expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('moved on\n');
			expect(result.status.behind).toBe(0);
		});

		it('aborts a conflicting sync by default, leaving the worktree clean', async () => {
			const path = await worktree();
			commit(path, 'README.md', 'from worktree\n', 'worktree edit');
			commit(source, 'README.md', 'from source\n', 'source edit');
			const { mergeWorktree } = await service();
			await expect(mergeWorktree(path, { direction: 'from-source' })).rejects.toMatchObject({
				code: 'merge_conflict'
			});
			expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('from worktree\n');
			expect(git(path, ['status', '--porcelain=v1'])).toBe('');
		});

		// The isolated tree is exactly where an agent is supposed to resolve
		// conflicts, so it may opt into keeping the conflicted state.
		it('keeps a conflicted sync in the worktree when asked', async () => {
			const path = await worktree();
			commit(path, 'README.md', 'from worktree\n', 'worktree edit');
			commit(source, 'README.md', 'from source\n', 'source edit');
			const { mergeWorktree } = await service();
			await expect(
				mergeWorktree(path, { direction: 'from-source', onConflict: 'keep' })
			).rejects.toMatchObject({ code: 'merge_conflict', detail: { conflicts: ['README.md'] } });
			expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('<<<<<<<');
		});

		it('unblocks a previously non-fast-forwardable integration', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			commit(source, 'upstream.txt', 'moved on\n', 'upstream commit');
			const { mergeWorktree } = await service();
			await mergeWorktree(path, { direction: 'from-source' });
			const integrated = await mergeWorktree(path, { direction: 'to-source' });
			expect(integrated).toMatchObject({ merged: true, fastForward: true });
			expect(readFileSync(join(source, 'feature.txt'), 'utf8')).toBe('work\n');
		});
	});

	describe('git worktree tools', () => {
		async function tool(cwd: string, name: string) {
			const { buildGitTools } = await import('../src/lib/server/tools/git');
			const found = buildGitTools(cwd).find((t) => t.name === name);
			if (!found) throw new Error(`missing tool ${name}`);
			return found;
		}

		it('git_worktree_status reports the worktree position', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			const result = await (await tool(path, 'git_worktree_status')).handler({});
			expect(result.ok).toBe(true);
			expect(result.ok && result.result).toMatchObject({
				isLinkedWorktree: true,
				ahead: 1,
				unmerged: true
			});
		});

		it('git_worktree_merge integrates and returns a summary', async () => {
			const path = await worktree();
			commit(path, 'feature.txt', 'work\n', 'worktree commit');
			const result = await (
				await tool(path, 'git_worktree_merge')
			).handler({ direction: 'to-source' });
			expect(result.ok).toBe(true);
			expect(result.summary).toContain('fast-forward');
			expect(readFileSync(join(source, 'feature.txt'), 'utf8')).toBe('work\n');
		});

		it('git_worktree_merge surfaces refusals as coded tool errors, not throws', async () => {
			const result = await (
				await tool(source, 'git_worktree_merge')
			).handler({ direction: 'to-source' });
			expect(result).toMatchObject({ ok: false, error: { code: 'not_a_worktree' } });
		});

		it('git_worktree_merge is always-prompt while status is not', async () => {
			const path = await worktree();
			expect((await tool(path, 'git_worktree_merge')).permissionBehavior).toBe('always-prompt');
			expect((await tool(path, 'git_worktree_status')).permissionBehavior).toBeUndefined();
		});

		it('git_commit nudges toward integration only inside a worktree', async () => {
			const path = await worktree();
			writeFileSync(join(path, 'feature.txt'), 'work\n');
			const inWorktree = await (
				await tool(path, 'git_commit')
			).handler({ paths: 'all', subject: 'add feature' });
			expect(inWorktree.ok && inWorktree.followUpHint).toContain('git_worktree_merge');

			writeFileSync(join(source, 'other.txt'), 'direct\n');
			const inSource = await (
				await tool(source, 'git_commit')
			).handler({ paths: 'all', subject: 'direct commit' });
			expect(inSource.ok && inSource.followUpHint).not.toContain('git_worktree_merge');
		});
	});
});
