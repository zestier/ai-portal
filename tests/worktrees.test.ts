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
				owner: { kind: 'conversation', userId: 'user-4', conversationId: 'STALE' }
			})
		).rejects.toMatchObject({ code: 'worktree_unavailable' });
		expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
	});
});

describe('worktree slot derivation', () => {
	let dataDir: string;
	let root: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-worktree-slot-test-');
		root = join(dataDir, 'managed-worktrees');
		process.env.WORKTREE_ROOT = root;
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();
	});

	it('derives conversation paths and branches exactly as before', async () => {
		const { slotPath, slotBranch, expectedManagedWorktreePath } = await service();
		const slot = { kind: 'conversation', userId: 'u1', conversationId: '01CONV' } as const;

		expect(slotPath(slot)).toBe(join(root, 'u1', '01CONV'));
		expect(slotBranch(slot)).toBe('portal/01CONV');
		// The public helper must keep returning the identical path, since it is
		// the fail-closed check for every managed-worktree conversation.
		expect(expectedManagedWorktreePath('u1', '01CONV')).toBe(slotPath(slot));
	});

	it('derives lease paths into a sibling namespace with a namespaced branch', async () => {
		const { slotPath, slotBranch } = await service();
		const slot = { kind: 'lease', userId: 'u1', leaseId: '01LEASE' } as const;

		expect(slotPath(slot)).toBe(join(root, 'u1', 'leases', '01LEASE'));
		expect(slotBranch(slot)).toBe('portal/lease/01LEASE');
	});

	it('appends a sanitized label to a lease branch', async () => {
		const { slotBranch } = await service();
		expect(slotBranch({ kind: 'lease', userId: 'u1', leaseId: '01LEASE', label: 'api-work' })).toBe(
			'portal/lease/01LEASE--api-work'
		);
	});

	it('never lets a lease branch collide with a conversation branch', async () => {
		const { slotBranch } = await service();
		const conversation = slotBranch({ kind: 'conversation', userId: 'u1', conversationId: '01X' });
		const lease = slotBranch({ kind: 'lease', userId: 'u1', leaseId: '01X' });
		expect(conversation).not.toBe(lease);
		expect(lease.startsWith('portal/lease/')).toBe(true);
	});

	it('rejects a conversation id that would capture the lease namespace', async () => {
		const { slotPath } = await service();
		expect(() =>
			slotPath({ kind: 'conversation', userId: 'u1', conversationId: 'leases' })
		).toThrowError(/reserved/);
	});

	it('rejects traversal in either slot identifier', async () => {
		const { slotPath } = await service();
		expect(() =>
			slotPath({ kind: 'conversation', userId: '../escape', conversationId: 'C' })
		).toThrowError(/invalid user id/);
		expect(() => slotPath({ kind: 'lease', userId: 'u1', leaseId: '../escape' })).toThrowError(
			/invalid lease id/
		);
	});

	it('accepts well-formed labels and rejects malformed ones without coercing', async () => {
		const { sanitizeLeaseLabel } = await service();
		for (const good of ['api', 'api-work', 'a', '9lives', 'a'.repeat(33)]) {
			expect(sanitizeLeaseLabel(good)).toBe(good);
		}
		for (const bad of [
			'', // empty
			'-leading', // refname-hostile leading dash
			'Trailing-Caps', // uppercase would change the branch the caller asked for
			'has space',
			'has/slash',
			'..',
			'a'.repeat(34)
		]) {
			expect(() => sanitizeLeaseLabel(bad)).toThrowError(/label must be/);
		}
	});

	it('rejects a symlinked lease namespace that escapes the worktree root', async () => {
		const source = committedRepository();
		const outside = makeTmpDir('portal-lease-outside-');
		mkdirSync(join(root, 'u9'), { recursive: true });
		// Plant `<root>/u9/leases -> /tmp/outside` before any lease is created.
		symlinkSync(outside, join(root, 'u9', 'leases'));
		const { createWorktreeForSlot } = await service();

		await expect(
			createWorktreeForSlot({
				sourceWorkdir: source,
				slot: { kind: 'lease', userId: 'u9', leaseId: '01ESCAPE' }
			})
		).rejects.toMatchObject({ code: 'invalid_identifier' });
		expect(existsSync(join(outside, '01ESCAPE'))).toBe(false);
	});

	it('creates an isolated lease checkout at its derived path', async () => {
		const source = committedRepository();
		const { createWorktreeForSlot } = await service();
		const metadata = await createWorktreeForSlot({
			sourceWorkdir: source,
			slot: { kind: 'lease', userId: 'u2', leaseId: '01LIVE', label: 'probe' }
		});

		expect(metadata.path).toBe(join(root, 'u2', 'leases', '01LIVE'));
		expect(metadata.branch).toBe('portal/lease/01LIVE--probe');
		expect(readFileSync(join(metadata.path, 'README.md'), 'utf8')).toBe('base\n');

		// Isolated from the source tree, which is the entire point.
		writeFileSync(join(metadata.path, 'README.md'), 'lease\n');
		expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('base\n');
	});

	it('rolls the checkout back when the persist hook throws', async () => {
		const source = committedRepository();
		const { createWorktreeForSlot } = await service();

		await expect(
			createWorktreeForSlot({
				sourceWorkdir: source,
				slot: { kind: 'lease', userId: 'u3', leaseId: '01ROLLBACK' },
				onCreated: () => {
					throw new Error('persist failed');
				}
			})
		).rejects.toThrowError('persist failed');

		// Neither an orphan directory nor an orphan branch may survive.
		expect(existsSync(join(root, 'u3', 'leases', '01ROLLBACK'))).toBe(false);
		expect(git(source, ['branch', '--list', 'portal/lease/01ROLLBACK'])).toBe('');
	});
});
