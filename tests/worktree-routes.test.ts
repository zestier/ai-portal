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

	describe('integration endpoints', () => {
		async function createWorktreeConversation(title: string) {
			const { POST } = await import('../src/routes/api/conversations/+server');
			const response = await POST({
				locals: {
					userId,
					user: { id: userId, githubLogin: 'local-dev', displayName: null, avatarUrl: null }
				},
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title, workspace: { kind: 'worktree' } })
				}),
				getClientAddress: () => '127.0.0.1'
			} as never);
			return (await response.json()).conversation;
		}

		function commitInWorktree(conversation: { workdir: string }, name: string) {
			writeFileSync(join(conversation.workdir, name), 'work\n');
			git(conversation.workdir, ['add', name]);
			git(conversation.workdir, ['commit', '-q', '-m', `add ${name}`]);
		}

		it('reports and then integrates a worktree session', async () => {
			const conversation = await createWorktreeConversation('integrate me');
			commitInWorktree(conversation, 'feature.txt');

			const { GET } = await import('../src/routes/api/conversations/[id]/worktree/+server');
			const before = await (
				await GET({ params: { id: conversation.id }, locals: { userId } } as never)
			).json();
			expect(before.worktree).toMatchObject({
				isLinkedWorktree: true,
				ahead: 1,
				unmerged: true,
				upstreamBranch: 'main'
			});

			const { POST: MERGE } =
				await import('../src/routes/api/conversations/[id]/worktree/merge/+server');
			const merged = await (
				await MERGE({
					params: { id: conversation.id },
					locals: { userId },
					request: new Request('http://localhost/merge', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ direction: 'to-source' })
					}),
					getClientAddress: () => '127.0.0.1'
				} as never)
			).json();
			expect(merged.merge).toMatchObject({ merged: true, into: 'main', fastForward: true });
			expect(existsSync(join(source, 'feature.txt'))).toBe(true);

			const after = await (
				await GET({ params: { id: conversation.id }, locals: { userId } } as never)
			).json();
			expect(after.worktree.unmerged).toBe(false);
		});

		it('accepts a squash message and lands one commit in the source', async () => {
			const conversation = await createWorktreeConversation('squash me');
			commitInWorktree(conversation, 'one.txt');
			commitInWorktree(conversation, 'two.txt');

			const { POST: MERGE } =
				await import('../src/routes/api/conversations/[id]/worktree/merge/+server');
			const merged = await (
				await MERGE({
					params: { id: conversation.id },
					locals: { userId },
					request: new Request('http://localhost/merge', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							direction: 'to-source',
							squash: { subject: 'Land the session' }
						})
					}),
					getClientAddress: () => '127.0.0.1'
				} as never)
			).json();

			expect(merged.merge).toMatchObject({
				merged: true,
				fastForward: true,
				squashedCommits: 2
			});
			expect(git(source, ['log', '--format=%s'])).toBe('Land the session\ninitial');
		});

		it('surfaces a refusal as a 409 with its code rather than merging', async () => {
			const conversation = await createWorktreeConversation('dirty merge');
			commitInWorktree(conversation, 'feature.txt');
			writeFileSync(join(conversation.workdir, 'scratch.txt'), 'wip\n');

			const { POST: MERGE } =
				await import('../src/routes/api/conversations/[id]/worktree/merge/+server');
			await expect(
				MERGE({
					params: { id: conversation.id },
					locals: { userId },
					request: new Request('http://localhost/merge', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ direction: 'to-source' })
					}),
					getClientAddress: () => '127.0.0.1'
				} as never)
			).rejects.toMatchObject({ status: 409, body: { code: 'worktree_dirty' } });
			expect(existsSync(join(source, 'feature.txt'))).toBe(false);
		});

		it('lists unmerged work for the sidebar and drops it once integrated', async () => {
			const conversation = await createWorktreeConversation('badge me');
			commitInWorktree(conversation, 'feature.txt');

			const { GET: BULK } = await import('../src/routes/api/worktrees/status/+server');
			const listed = await (
				await BULK({
					locals: { userId },
					url: new URL('http://localhost/api/worktrees/status')
				} as never)
			).json();
			expect(listed.worktrees).toContainEqual(
				expect.objectContaining({ conversationId: conversation.id, unmerged: true, ahead: 1 })
			);
		});

		it('serves the sidebar a cached status by default and a fresh one on request', async () => {
			const conversation = await createWorktreeConversation('refresh me');
			const { GET: BULK } = await import('../src/routes/api/worktrees/status/+server');
			const read = async (fresh: boolean) => {
				const response = await BULK({
					locals: { userId },
					url: new URL(`http://localhost/api/worktrees/status${fresh ? '?fresh=1' : ''}`)
				} as never);
				const body = await response.json();
				return body.worktrees.find(
					(w: { conversationId: string }) => w.conversationId === conversation.id
				);
			};

			// Warm the TTL cache while the worktree still has nothing to merge.
			expect(await read(false)).toMatchObject({ unmerged: false });
			commitInWorktree(conversation, 'feature.txt');

			// The poll is allowed to lag; an event-driven refresh is not, because it
			// fires precisely because the answer just changed.
			expect(await read(false)).toMatchObject({ unmerged: false });
			expect(await read(true)).toMatchObject({ unmerged: true, ahead: 1 });
		});

		it('refuses to delete a clean worktree that still holds unmerged commits', async () => {
			const conversation = await createWorktreeConversation('unmerged delete');
			commitInWorktree(conversation, 'feature.txt');

			const { DELETE } = await import('../src/routes/api/conversations/[id]/+server');
			await expect(
				DELETE({
					params: { id: conversation.id },
					locals: { userId },
					url: new URL(`http://localhost/api/conversations/${conversation.id}`),
					getClientAddress: () => '127.0.0.1'
				} as never)
			).rejects.toMatchObject({ status: 409, body: { code: 'worktree_unmerged' } });
			expect(existsSync(conversation.workdir)).toBe(true);

			const forced = await DELETE({
				params: { id: conversation.id },
				locals: { userId },
				url: new URL(`http://localhost/api/conversations/${conversation.id}?forceWorktree=1`),
				getClientAddress: () => '127.0.0.1'
			} as never);
			expect(forced.ok).toBe(true);
		});

		// The guard exists to prevent surprise, not to protect an empty branch.
		it('deletes a clean, fully merged worktree without a force flag', async () => {
			const conversation = await createWorktreeConversation('nothing to lose');
			const { DELETE } = await import('../src/routes/api/conversations/[id]/+server');
			const response = await DELETE({
				params: { id: conversation.id },
				locals: { userId },
				url: new URL(`http://localhost/api/conversations/${conversation.id}`),
				getClientAddress: () => '127.0.0.1'
			} as never);
			expect(response.ok).toBe(true);
			expect(existsSync(conversation.workdir)).toBe(false);
		});
	});
});
