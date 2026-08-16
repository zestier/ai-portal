import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from '../../helpers/env';
import { makeTmpDir } from '../../helpers/tmp';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-lease-route-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

describe('lease-scoped conversation routes', () => {
	let source: string;
	let userId: number;
	let conversationId: string;
	let otherConversationId: string;

	async function makeLease(convId = conversationId, label = 'api') {
		const convs = await import('../../../src/lib/server/db/repos/conversations');
		const { createLease } = await import('../../../src/lib/server/leases');
		const conversation = convs.get(convId, userId)!;
		return createLease({ conversation, label });
	}

	function ctx(query = '', extraParams: Record<string, string | number> = {}) {
		return {
			params: { id: conversationId, ...extraParams },
			locals: {
				userId,
				user: { id: userId, githubLogin: 'local-dev', displayName: null, avatarUrl: null }
			},
			url: new URL(`http://localhost/api/conversations/${conversationId}/x${query}`),
			getClientAddress: () => '127.0.0.1'
		} as never;
	}

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-lease-routes-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		process.env.WORKTREE_ROOT = join(dataDir, 'worktrees');
		await resetServerSingletons();
		vi.resetModules();

		const users = await import('../../../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
		const convs = await import('../../../src/lib/server/db/repos/conversations');
		const base = {
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared' as const,
			workspaceKey: source
		};
		conversationId = convs.create(userId, { title: 'main', ...base }).id;
		otherConversationId = convs.create(userId, { title: 'other', ...base }).id;
	});

	it('lists held worktrees with dirty counts', async () => {
		const lease = await makeLease();
		writeFileSync(join(lease.path, 'wip.txt'), 'x\n');

		const { GET } = await import('../../../src/routes/api/conversations/[id]/worktrees/+server');
		const body = await (await GET(ctx())).json();

		expect(body.worktrees).toHaveLength(1);
		expect(body.worktrees[0]).toMatchObject({
			id: lease.id,
			label: 'api',
			branch: lease.branch,
			available: true,
			dirtyCount: 1
		});
	});

	it('still lists a lease whose checkout has vanished, flagged unavailable', async () => {
		const lease = await makeLease();
		rmSync(lease.path, { recursive: true, force: true });

		const { GET } = await import('../../../src/routes/api/conversations/[id]/worktrees/+server');
		const body = await (await GET(ctx())).json();

		// Omitting it would make the work look like it never existed.
		expect(body.worktrees).toHaveLength(1);
		expect(body.worktrees[0]).toMatchObject({ id: lease.id, available: false, dirtyCount: null });
	});

	describe('POST', () => {
		it('creates a lease rooted in the conversation repository', async () => {
			const { POST } = await import('../../../src/routes/api/conversations/[id]/worktrees/+server');
			const res = await POST({
				...(ctx() as unknown as Record<string, unknown>),
				request: new Request('http://localhost/x', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ label: 'manual' })
				})
			} as never);

			expect(res.status).toBe(201);
			const { worktree } = await res.json();
			expect(worktree.label).toBe('manual');
			// The repository is derived, never supplied by the caller.
			expect(worktree.sourceWorkdir).toBe(source);
			expect(existsSync(worktree.path)).toBe(true);
		});

		it('rejects a malformed label', async () => {
			const { POST } = await import('../../../src/routes/api/conversations/[id]/worktrees/+server');
			await expect(
				POST({
					...(ctx() as unknown as Record<string, unknown>),
					request: new Request('http://localhost/x', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ label: 'Not A Slug' })
					})
				} as never)
			).rejects.toMatchObject({ status: 400 });
		});
	});

	it('reads the file tree of a lease rather than the conversation workspace', async () => {
		const lease = await makeLease();
		writeFileSync(join(lease.path, 'only-in-lease.txt'), 'x\n');

		const { GET } = await import('../../../src/routes/api/conversations/[id]/fs/tree/+server');
		const inLease = await (await GET(ctx(`?worktree=${lease.id}`))).json();
		const inPrimary = await (await GET(ctx())).json();

		expect(inLease.entries.map((e: { name: string }) => e.name)).toContain('only-in-lease.txt');
		// Omitting the selector must still resolve the conversation's own tree.
		expect(inPrimary.entries.map((e: { name: string }) => e.name)).not.toContain(
			'only-in-lease.txt'
		);
	});

	it('reads a file from the selected lease', async () => {
		const lease = await makeLease();
		writeFileSync(join(lease.path, 'README.md'), 'lease copy\n');

		const { GET } = await import('../../../src/routes/api/conversations/[id]/fs/file/+server');
		const body = await (await GET(ctx(`?path=README.md&worktree=${lease.id}`))).json();

		expect(body.file.content).toBe('lease copy\n');
	});

	it('reports git changes for the selected lease', async () => {
		const lease = await makeLease();
		writeFileSync(join(lease.path, 'changed.txt'), 'x\n');

		const { GET } = await import('../../../src/routes/api/conversations/[id]/git/changes/+server');
		const body = await (await GET(ctx(`?worktree=${lease.id}`))).json();

		expect(body.entries.map((c: { path: string }) => c.path)).toContain('changed.txt');
	});

	it('reverts the lease it was pointed at, never the conversation workspace', async () => {
		// The data-loss case: if revert ignored the selector it would discard the
		// tree the user was NOT looking at and leave the one they were.
		const lease = await makeLease();
		writeFileSync(join(lease.path, 'README.md'), 'lease edit\n');
		writeFileSync(join(source, 'README.md'), 'primary edit\n');

		const { POST } =
			await import('../../../src/routes/api/conversations/[id]/git/changes/revert/+server');
		await POST(ctx(`?worktree=${lease.id}`));

		expect(readFileSync(join(lease.path, 'README.md'), 'utf8')).toBe('base\n');
		expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('primary edit\n');
	});

	describe('ownership', () => {
		it('404s a lease held by a different conversation', async () => {
			const foreign = await makeLease(otherConversationId, 'foreign');
			const { GET } = await import('../../../src/routes/api/conversations/[id]/fs/tree/+server');

			await expect(GET(ctx(`?worktree=${foreign.id}`))).rejects.toMatchObject({ status: 404 });
		});

		it('404s an unknown lease id', async () => {
			const { GET } = await import('../../../src/routes/api/conversations/[id]/fs/tree/+server');
			await expect(GET(ctx('?worktree=999999'))).rejects.toMatchObject({ status: 404 });
		});

		it('404s a lease belonging to another user', async () => {
			const lease = await makeLease();
			const { GET } = await import('../../../src/routes/api/conversations/[id]/fs/tree/+server');
			const foreignCtx = {
				params: { id: conversationId },
				locals: { userId: 999999 },
				url: new URL(`http://localhost/x?worktree=${lease.id}`)
			} as never;

			await expect(GET(foreignCtx)).rejects.toMatchObject({ status: 404 });
		});
	});

	describe('DELETE', () => {
		it('refuses a dirty lease, then removes it when forced', async () => {
			const lease = await makeLease();
			writeFileSync(join(lease.path, 'wip.txt'), 'unsaved\n');
			const { DELETE } =
				await import('../../../src/routes/api/conversations/[id]/worktrees/[leaseId]/+server');

			await expect(DELETE(ctx('', { leaseId: lease.id }))).rejects.toMatchObject({ status: 409 });
			expect(existsSync(lease.path)).toBe(true);

			const res = await DELETE(ctx('?force=1', { leaseId: lease.id }));
			expect((await res.json()).ok).toBe(true);
			expect(existsSync(lease.path)).toBe(false);
		});

		it('404s a lease held by another conversation', async () => {
			const foreign = await makeLease(otherConversationId, 'foreign');
			const { DELETE } =
				await import('../../../src/routes/api/conversations/[id]/worktrees/[leaseId]/+server');

			await expect(DELETE(ctx('', { leaseId: foreign.id }))).rejects.toMatchObject({
				status: 404
			});
			expect(existsSync(foreign.path)).toBe(true);
		});
	});

	describe('conversation delete', () => {
		function convCtx(query = '') {
			return {
				params: { id: conversationId },
				locals: {
					userId,
					user: { id: userId, githubLogin: 'local-dev', displayName: null, avatarUrl: null }
				},
				url: new URL(`http://localhost/api/conversations/${conversationId}${query}`),
				getClientAddress: () => '127.0.0.1'
			} as never;
		}

		function commitInLease(path: string) {
			writeFileSync(join(path, 'feature.txt'), 'work\n');
			git(path, ['add', 'feature.txt']);
			git(path, ['commit', '-q', '-m', 'feature']);
		}

		/** Invoke DELETE and return the thrown HttpError rather than a response. */
		async function expectDeleteRejection(query = ''): Promise<{
			status: number;
			body: {
				code: string;
				leases: Array<{ id: string; reason: string; dirtyCount: number; ahead: number }>;
			};
		}> {
			const { DELETE } = await import('../../../src/routes/api/conversations/[id]/+server');
			try {
				await DELETE(convCtx(query));
			} catch (e) {
				return e as { status: number; body: never };
			}
			throw new Error('expected DELETE to reject');
		}

		it('refuses when a lease holds unmerged commits, naming the reason', async () => {
			const lease = await makeLease();
			commitInLease(lease.path);

			const err = await expectDeleteRejection();

			expect(err.status).toBe(409);
			expect(err.body.code).toBe('worktree_unmerged');
			expect(err.body.leases[0]).toMatchObject({ id: lease.id, reason: 'unmerged', ahead: 1 });
			expect(existsSync(lease.path)).toBe(true);
		});

		it('leads with the dirty reason when both kinds are present', async () => {
			// Losing uncommitted work is worse than orphaning a branch, so that is
			// the reason the user should see first.
			const unmerged = await makeLease(conversationId, 'committed');
			commitInLease(unmerged.path);
			const dirty = await makeLease(conversationId, 'wip');
			writeFileSync(join(dirty.path, 'wip.txt'), 'unsaved\n');

			const err = await expectDeleteRejection();

			expect(err.status).toBe(409);
			expect(err.body.code).toBe('worktree_dirty');
			const reasons = Object.fromEntries(err.body.leases.map((l) => [l.id, l.reason]));
			expect(reasons[unmerged.id]).toBe('unmerged');
			expect(reasons[dirty.id]).toBe('dirty');
		});

		it('deletes with force, leaving the unmerged branch behind', async () => {
			const lease = await makeLease();
			commitInLease(lease.path);

			const { DELETE } = await import('../../../src/routes/api/conversations/[id]/+server');
			const res = await DELETE(convCtx('?forceWorktree=1'));

			expect((await res.json()).ok).toBe(true);
			expect(existsSync(lease.path)).toBe(false);
			// The commits themselves survive; only the checkout is gone.
			expect(git(source, ['branch', '--list', lease.branch])).toContain(lease.branch);
		});
	});
});
