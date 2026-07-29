import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-lease-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

describe('workspace leases', () => {
	let source: string;
	let userId: string;
	let worktreeRoot: string;

	async function makeConversation() {
		const convs = await import('../src/lib/server/db/repos/conversations');
		return convs.create(userId, {
			id: convs.newId(),
			title: 'orchestrator',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		});
	}

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-leases-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		worktreeRoot = join(dataDir, 'worktrees');
		process.env.WORKTREE_ROOT = worktreeRoot;
		await resetServerSingletons();
		vi.resetModules();
		const users = await import('../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
	});

	it('creates an isolated lease checkout owned by the conversation', async () => {
		const conversation = await makeConversation();
		const { createLease, resolveLeaseWorkspace, listLeases } =
			await import('../src/lib/server/leases');

		const lease = await createLease({ conversation, label: 'api' });

		expect(lease.path).toBe(join(worktreeRoot, userId, 'leases', lease.id));
		expect(lease.branch).toBe(`portal/lease/${lease.id}--api`);
		expect(lease.heldByConversationId).toBe(conversation.id);
		expect(resolveLeaseWorkspace(lease)).toBe(lease.path);
		expect(listLeases(conversation.id, userId)).toHaveLength(1);

		// The whole point: edits here do not touch the source tree.
		writeFileSync(join(lease.path, 'README.md'), 'lease\n');
		expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('base\n');
	});

	it('cuts leases from the source repository, never from a tool argument', async () => {
		const conversation = await makeConversation();
		const { createLease } = await import('../src/lib/server/leases');
		const lease = await createLease({ conversation, label: 'x' });
		// Even though the caller supplied nothing, the lease is rooted in the
		// conversation's own repository — this is what prevents an agent from
		// using lease creation to escape ALLOWED_WORKDIRS.
		expect(lease.sourceWorkdir).toBe(source);
	});

	it('enforces the per-conversation quota', async () => {
		process.env.WORKTREE_MAX_LEASES_PER_CONVERSATION = '2';
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();

		const conversation = await makeConversation();
		const { createLease } = await import('../src/lib/server/leases');
		await createLease({ conversation, label: 'one' });
		await createLease({ conversation, label: 'two' });

		await expect(createLease({ conversation, label: 'three' })).rejects.toMatchObject({
			code: 'lease_quota_exceeded'
		});
		delete process.env.WORKTREE_MAX_LEASES_PER_CONVERSATION;
	});

	it('serializes concurrent creates and leaves no partial state', async () => {
		const conversation = await makeConversation();
		const { createLease, listLeases } = await import('../src/lib/server/leases');

		const leases = await Promise.all([
			createLease({ conversation, label: 'a' }),
			createLease({ conversation, label: 'b' }),
			createLease({ conversation, label: 'c' })
		]);

		expect(new Set(leases.map((l) => l.path)).size).toBe(3);
		expect(listLeases(conversation.id, userId)).toHaveLength(3);
		for (const lease of leases) expect(existsSync(lease.path)).toBe(true);
	});

	it('refuses to remove a dirty lease unless forced', async () => {
		const conversation = await makeConversation();
		const { createLease, removeLease, getLease } = await import('../src/lib/server/leases');
		const lease = await createLease({ conversation, label: 'dirty' });
		writeFileSync(join(lease.path, 'scratch.txt'), 'unsaved\n');

		await expect(removeLease(lease)).rejects.toMatchObject({ code: 'worktree_dirty' });
		expect(existsSync(lease.path)).toBe(true);
		expect(getLease(lease.id, userId)).not.toBeNull();

		await removeLease(lease, { force: true });
		expect(existsSync(lease.path)).toBe(false);
		expect(getLease(lease.id, userId)).toBeNull();
	});

	it('retains an unmerged branch when the lease is dropped', async () => {
		const conversation = await makeConversation();
		const { createLease, removeLease } = await import('../src/lib/server/leases');
		const lease = await createLease({ conversation, label: 'work' });

		writeFileSync(join(lease.path, 'feature.txt'), 'real work\n');
		git(lease.path, ['add', 'feature.txt']);
		git(lease.path, ['commit', '-q', '-m', 'feature']);

		const result = await removeLease(lease);

		// Checkout gone, but committed work survives under its branch.
		expect(existsSync(lease.path)).toBe(false);
		expect(result.branchDeleted).toBe(false);
		expect(git(source, ['branch', '--list', lease.branch])).toContain(lease.branch);
	});

	it('deletes the branch when the lease had no unmerged commits', async () => {
		const conversation = await makeConversation();
		const { createLease, removeLease } = await import('../src/lib/server/leases');
		const lease = await createLease({ conversation, label: 'empty' });

		const result = await removeLease(lease);

		expect(result.branchDeleted).toBe(true);
		expect(git(source, ['branch', '--list', lease.branch])).toBe('');
	});

	describe('fail-closed resolution', () => {
		it('rejects a lease whose stored path was tampered with', async () => {
			const conversation = await makeConversation();
			const { createLease, resolveLeaseWorkspace } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'tamper' });
			const outside = makeTmpDir('portal-lease-outside-');

			expect(() => resolveLeaseWorkspace({ ...lease, path: outside })).toThrowError(
				/unavailable|invalid/
			);
		});

		it('rejects a lease whose checkout was replaced by a symlink', async () => {
			const conversation = await makeConversation();
			const { createLease, resolveLeaseWorkspace } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'swap' });
			const outside = makeTmpDir('portal-lease-swap-');

			rmSync(lease.path, { recursive: true, force: true });
			symlinkSync(outside, lease.path);

			expect(() => resolveLeaseWorkspace(lease)).toThrowError(/invalid|not accessible/);
		});

		it('rejects a lease belonging to another user', async () => {
			const conversation = await makeConversation();
			const { createLease, getLease } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'mine' });

			expect(getLease(lease.id, 'someone-else')).toBeNull();
		});
	});

	describe('containment roots', () => {
		it('exposes the primary workspace first, then each lease', async () => {
			const conversation = await makeConversation();
			const { createLease, conversationWorkspaceRoots } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'root' });

			const roots = conversationWorkspaceRoots(conversation);
			expect(roots[0]).toBe(source);
			expect(roots).toContain(lease.path);
		});

		it('skips a broken lease rather than losing the primary workspace', async () => {
			const conversation = await makeConversation();
			const { createLease, conversationWorkspaceRoots } = await import('../src/lib/server/leases');
			const good = await createLease({ conversation, label: 'good' });
			const broken = await createLease({ conversation, label: 'broken' });
			rmSync(broken.path, { recursive: true, force: true });

			const roots = conversationWorkspaceRoots(conversation);
			// One bad checkout must not lock the user out of everything else.
			expect(roots).toContain(source);
			expect(roots).toContain(good.path);
			expect(roots).not.toContain(broken.path);
		});

		it('reflects a lease created mid-session without re-resolving anything', async () => {
			// This is what forces `getWorkspaceRoots` to be a CALLBACK rather than a
			// value captured at session establishment. An orchestrator creates
			// leases during a turn, and a lease created in turn N must be writable
			// within turn N — a snapshot would be stale exactly when it matters.
			const conversation = await makeConversation();
			const { createLease, workspaceRootsFor } = await import('../src/lib/server/leases');

			const before = workspaceRootsFor(conversation.id, userId, source);
			expect(before).toEqual([source]);

			const lease = await createLease({ conversation, label: 'midturn' });

			const after = workspaceRootsFor(conversation.id, userId, source);
			expect(after).toContain(lease.path);
			expect(after[0]).toBe(source);
		});

		it('falls back to the session workdir when the conversation is unreadable', async () => {
			const { workspaceRootsFor } = await import('../src/lib/server/leases');
			// Never narrower than pre-lease behavior: an unknown conversation still
			// gets its working directory as a root rather than an empty set.
			expect(workspaceRootsFor('missing-conversation', userId, source)).toEqual([source]);
		});
	});

	describe('garbage collection', () => {
		it('reaps idle clean leases but never dirty ones', async () => {
			const conversation = await makeConversation();
			const { createLease, reapIdleLeases, getLease } = await import('../src/lib/server/leases');
			const leaseRepo = await import('../src/lib/server/db/repos/leases');

			const clean = await createLease({ conversation, label: 'clean' });
			const dirty = await createLease({ conversation, label: 'dirty' });
			writeFileSync(join(dirty.path, 'wip.txt'), 'uncommitted\n');

			// Age both well past the TTL.
			const longAgo = Date.now() - 90 * 24 * 60 * 60_000;
			leaseRepo.touch(clean.id, longAgo);
			leaseRepo.touch(dirty.id, longAgo);

			const { removed } = await reapIdleLeases();

			expect(removed).toBe(1);
			expect(getLease(clean.id, userId)).toBeNull();
			expect(getLease(dirty.id, userId)).not.toBeNull();
			expect(existsSync(dirty.path)).toBe(true);
		});

		it('leaves recently used leases alone', async () => {
			const conversation = await makeConversation();
			const { createLease, reapIdleLeases, getLease } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'fresh' });

			const { removed } = await reapIdleLeases();

			expect(removed).toBe(0);
			expect(getLease(lease.id, userId)).not.toBeNull();
		});

		it('drops rows whose checkout vanished', async () => {
			const conversation = await makeConversation();
			const { createLease, reconcileLeases, getLease } = await import('../src/lib/server/leases');
			const lease = await createLease({ conversation, label: 'ghost' });
			rmSync(lease.path, { recursive: true, force: true });

			const { rowsDropped } = await reconcileLeases();

			expect(rowsDropped).toBe(1);
			expect(getLease(lease.id, userId)).toBeNull();
		});
	});

	it('removes every lease held by a conversation, reporting dirty holdouts', async () => {
		const conversation = await makeConversation();
		const { createLease, removeLeasesForConversation } = await import('../src/lib/server/leases');
		const clean = await createLease({ conversation, label: 'clean' });
		const dirty = await createLease({ conversation, label: 'dirty' });
		writeFileSync(join(dirty.path, 'wip.txt'), 'uncommitted\n');

		const result = await removeLeasesForConversation(conversation.id, userId);

		expect(result.removed).toEqual([clean.id]);
		expect(result.retained.map((r) => r.lease.id)).toEqual([dirty.id]);
		expect(existsSync(dirty.path)).toBe(true);

		const forced = await removeLeasesForConversation(conversation.id, userId, { force: true });
		expect(forced.removed).toEqual([dirty.id]);
		expect(existsSync(dirty.path)).toBe(false);
	});
});
