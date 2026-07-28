import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-worktree-route-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

describe('managed worktree conversation routes', () => {
	let source: string;
	let userId: string;

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-worktree-routes-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		process.env.WORKTREE_ROOT = join(dataDir, 'worktrees');
		await resetServerSingletons();
		vi.resetModules();
		const users = await import('../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
	});

	it('creates, archives, protects, and force-removes a managed worktree', async () => {
		const { POST } = await import('../src/routes/api/conversations/+server');
		const sourceSubdir = join(source, 'nested');
		mkdirSync(sourceSubdir);
		const createResponse = await POST({
			locals: {
				userId,
				user: { id: userId, githubLogin: 'local-dev', displayName: null, avatarUrl: null }
			},
			request: new Request('http://localhost/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'isolated',
					workspace: { kind: 'worktree', sourcePath: sourceSubdir }
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);
		const created = await createResponse.json();
		const conversation = created.conversation;
		expect(conversation.workspaceKind).toBe('managed-worktree');
		expect(conversation.workspaceKey).toBe(source);
		expect(existsSync(conversation.workdir)).toBe(true);

		const { PATCH, DELETE } = await import('../src/routes/api/conversations/[id]/+server');
		const archiveResponse = await PATCH({
			params: { id: conversation.id },
			locals: { userId },
			request: new Request(`http://localhost/api/conversations/${conversation.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ archived: true })
			})
		} as never);
		expect(archiveResponse.ok).toBe(true);
		expect(existsSync(conversation.workdir)).toBe(true);

		writeFileSync(join(conversation.workdir, 'dirty.txt'), 'uncommitted\n');
		await expect(
			DELETE({
				params: { id: conversation.id },
				locals: { userId },
				url: new URL(`http://localhost/api/conversations/${conversation.id}`),
				getClientAddress: () => '127.0.0.1'
			} as never)
		).rejects.toMatchObject({ status: 409, body: { code: 'worktree_dirty' } });
		expect(existsSync(conversation.workdir)).toBe(true);

		const deleteResponse = await DELETE({
			params: { id: conversation.id },
			locals: { userId },
			url: new URL(`http://localhost/api/conversations/${conversation.id}?forceWorktree=1`),
			getClientAddress: () => '127.0.0.1'
		} as never);
		expect(deleteResponse.ok).toBe(true);
		expect(existsSync(conversation.workdir)).toBe(false);
		expect(git(source, ['branch', '--list', conversation.worktreeBranch])).toContain(
			conversation.worktreeBranch
		);
	});

	it('force-removes an owned checkout after its source repository moves', async () => {
		const { POST } = await import('../src/routes/api/conversations/+server');
		const createResponse = await POST({
			locals: {
				userId,
				user: { id: userId, githubLogin: 'local-dev', displayName: null, avatarUrl: null }
			},
			request: new Request('http://localhost/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'stale source', workspace: { kind: 'worktree' } })
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);
		const { conversation } = await createResponse.json();
		const movedSource = `${source}-moved`;
		renameSync(source, movedSource);

		const { DELETE } = await import('../src/routes/api/conversations/[id]/+server');
		const deleteResponse = await DELETE({
			params: { id: conversation.id },
			locals: { userId },
			url: new URL(`http://localhost/api/conversations/${conversation.id}?forceWorktree=1`),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(deleteResponse.ok).toBe(true);
		expect(existsSync(conversation.workdir)).toBe(false);
		const convs = await import('../src/lib/server/db/repos/conversations');
		expect(convs.get(conversation.id, userId)).toBeNull();
	});
});
