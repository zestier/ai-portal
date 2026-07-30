// End-to-end acceptance check for the orchestrator worktree flow.
//
// The unit suites cover each piece in isolation; this one ties them together in
// the order a real orchestrator hits them, because the interesting failure is at
// the seams:
//
//   worktree_create (tool)  →  write inside the returned path is AUTO-APPROVED
//                              (no prompt) via the live permission roots
//                           →  worktree_remove (tool)
//                           →  writes there are no longer auto-approved
//
// The middle step is the one that matters. Phase 0 showed that when a lease is
// not an allowed root, the write is auto-DENIED under best-effort and the
// sub-agent's fallback is to write into the shared tree instead.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import type { PortalTool, ToolResult } from '../src/lib/server/tools/types';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-wt-e2e-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

function payload(r: ToolResult): Record<string, unknown> {
	if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`);
	return r.result as Record<string, unknown>;
}

describe('orchestrator worktree flow (acceptance)', () => {
	let source: string;
	let userId: string;
	let conversationId: string;
	let tools: Map<string, PortalTool>;
	let gitTools: Map<string, PortalTool>;
	let decide: typeof import('../src/lib/server/runtime/interactive-requests').decideByPolicy;
	let rootsFor: typeof import('../src/lib/server/leases').workspaceRootsFor;

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-wt-e2e-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		process.env.WORKTREE_ROOT = join(dataDir, 'worktrees');
		await resetServerSingletons();
		vi.resetModules();

		const users = await import('../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
		const convs = await import('../src/lib/server/db/repos/conversations');
		conversationId = convs.create(userId, {
			id: convs.newId(),
			title: 'orchestrator',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		}).id;

		const { buildWorktreeTools } = await import('../src/lib/server/tools/worktree');
		tools = new Map(buildWorktreeTools({ userId, conversationId }).map((t) => [t.name, t]));
		const { buildGitTools } = await import('../src/lib/server/tools/git');
		gitTools = new Map(buildGitTools(source, { userId, conversationId }).map((t) => [t.name, t]));
		({ decideByPolicy: decide } = await import('../src/lib/server/runtime/interactive-requests'));
		({ workspaceRootsFor: rootsFor } = await import('../src/lib/server/leases'));
	});

	/** What the permission gateway would decide for a write, right now. */
	function writeDecision(target: string) {
		return decide('prompt', 'permission', 'write', {
			scopeKey: target,
			workspaceRoots: rootsFor(conversationId, userId, source)
		});
	}

	it('lets a sub-agent write in a fresh worktree without prompting, then revokes on removal', async () => {
		// Before any lease exists, only the shared workspace is writable.
		expect(writeDecision(join(source, 'in-main.ts'))).toBe('approved');

		const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
		const leasePath = created.path as string;
		const leaseId = created.leaseId as string;

		// The directory the orchestrator hands to a sub-agent really exists…
		expect(existsSync(leasePath)).toBe(true);
		// …and writing in it is auto-approved in the SAME turn it was created.
		// A captured-at-session-start root set would fail right here.
		expect(writeDecision(join(leasePath, 'feature.ts'))).toBe('approved');
		expect(writeDecision(join(leasePath, 'nested', 'deep', 'feature.ts'))).toBe('approved');

		// Unrelated locations are still gated.
		expect(writeDecision(join(makeTmpDir('portal-wt-e2e-outside-'), 'x.ts'))).toBe('ask');

		// The sub-agent does its work in the lease; the shared tree is untouched.
		writeFileSync(join(leasePath, 'feature.ts'), 'export const x = 1;\n');
		expect(existsSync(join(source, 'feature.ts'))).toBe(false);

		// Commit it so removal is clean, then tear down.
		git(leasePath, ['add', 'feature.ts']);
		git(leasePath, ['commit', '-q', '-m', 'feature']);
		const removed = payload(await tools.get('worktree_remove')!.handler({ leaseId }));

		expect(removed.removed).toBe(true);
		expect(existsSync(leasePath)).toBe(false);
		// Unmerged work survives as a branch rather than being destroyed.
		expect(removed.branchDeleted).toBe(false);
		expect(git(source, ['branch', '--list', removed.branch as string])).toContain(
			removed.branch as string
		);

		// Once the lease is gone, its path is no longer privileged.
		expect(writeDecision(join(leasePath, 'feature.ts'))).toBe('ask');
	});

	it('keeps two parallel worktrees isolated from each other and from the shared tree', async () => {
		const create = tools.get('worktree_create')!;
		const a = payload(await create.handler({ label: 'alpha' }));
		const b = payload(await create.handler({ label: 'beta' }));

		const pathA = a.path as string;
		const pathB = b.path as string;
		expect(pathA).not.toBe(pathB);
		expect(a.branch).not.toBe(b.branch);

		// Both are writable without prompting — the point of fanning out.
		expect(writeDecision(join(pathA, 'x.ts'))).toBe('approved');
		expect(writeDecision(join(pathB, 'x.ts'))).toBe('approved');

		// Same filename in both, different content: neither clobbers the other,
		// which is precisely what would happen in one shared tree.
		writeFileSync(join(pathA, 'shared-name.ts'), 'alpha\n');
		writeFileSync(join(pathB, 'shared-name.ts'), 'beta\n');
		expect(existsSync(join(source, 'shared-name.ts'))).toBe(false);

		const list = payload(await tools.get('worktree_list')!.handler({}));
		const rows = list.worktrees as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.label).sort()).toEqual(['alpha', 'beta']);
		expect(rows.every((r) => r.dirtyCount === 1)).toBe(true);
	});

	it('refuses to strand uncommitted sub-agent work on removal', async () => {
		const created = payload(await tools.get('worktree_create')!.handler({ label: 'wip' }));
		writeFileSync(join(created.path as string, 'unsaved.ts'), 'half done\n');

		const res = await tools.get('worktree_remove')!.handler({ leaseId: created.leaseId as string });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('worktree_dirty');
		expect(existsSync(created.path as string)).toBe(true);
	});

	// Fanning work out is only useful if the orchestrator can then SEE it. Shell
	// `git` is not a fallback here (no seeded git shell grant), so without the
	// `worktree` selector a sub-agent's work is invisible until it is merged.
	describe('git read tools targeting a lease', () => {
		it('inspects a lease without disturbing the conversation-local reads', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leasePath = created.path as string;
			const leaseId = created.leaseId as string;
			writeFileSync(join(leasePath, 'feature.ts'), 'export const x = 1;\n');
			git(leasePath, ['add', 'feature.ts']);
			git(leasePath, ['commit', '-q', '-m', 'sub-agent work']);
			writeFileSync(join(leasePath, 'scratch.ts'), 'wip\n');

			const inLease = payload(await gitTools.get('git_status')!.handler({ worktree: leaseId }));
			expect((inLease.changes as unknown[]).length).toBe(1);
			const inMain = payload(await gitTools.get('git_status')!.handler({}));
			expect(inMain.changes).toEqual([]);

			const leaseLog = payload(await gitTools.get('git_log')!.handler({ worktree: leaseId }));
			const leaseSubjects = (leaseLog.commits as Array<{ subject: string }>).map((c) => c.subject);
			expect(leaseSubjects).toContain('sub-agent work');
			const mainLog = payload(await gitTools.get('git_log')!.handler({}));
			expect((mainLog.commits as Array<{ subject: string }>).map((c) => c.subject)).not.toContain(
				'sub-agent work'
			);

			const patch = await gitTools.get('git_diff')!.handler({
				worktree: leaseId,
				target: 'commit-vs-parent',
				sha: git(leasePath, ['rev-parse', 'HEAD'])
			});
			expect(patch.ok && String(patch.result)).toContain('feature.ts');
		});

		it('refuses a lease this conversation does not hold', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const convs = await import('../src/lib/server/db/repos/conversations');
			const other = convs.create(userId, {
				id: convs.newId(),
				title: 'other',
				workdir: source,
				model: 'test-model',
				workspaceKind: 'shared',
				workspaceKey: source
			});
			const { buildGitTools } = await import('../src/lib/server/tools/git');
			const otherTools = new Map(
				buildGitTools(source, { userId, conversationId: other.id }).map((t) => [t.name, t])
			);

			const res = await otherTools
				.get('git_status')!
				.handler({ worktree: created.leaseId as string });
			expect(res).toMatchObject({ ok: false, error: { code: 'lease_not_found' } });
			expect(await gitTools.get('git_status')!.handler({ worktree: 'nope' })).toMatchObject({
				ok: false,
				error: { code: 'lease_not_found' }
			});
		});

		// Without session context the selector cannot be authorized, so it must
		// fail loudly rather than silently reading the conversation's own tree and
		// reporting it as the lease's.
		it('rejects the selector when the session context is unavailable', async () => {
			const { buildGitTools } = await import('../src/lib/server/tools/git');
			const bare = new Map(buildGitTools(source).map((t) => [t.name, t]));
			expect(await bare.get('git_status')!.handler({ worktree: 'anything' })).toMatchObject({
				ok: false,
				error: { code: 'worktree_unavailable' }
			});
			expect((await bare.get('git_status')!.handler({})).ok).toBe(true);
		});
	});

	// The write half of the same problem. A sub-agent handed only a lease path
	// has no shell git (no seeded grant) and, before `git_commit` took a
	// `worktree`, no structured way to commit either — so its work stayed
	// uncommitted, `worktree_merge` found `ahead: 0`, and the whole fan-out was
	// silently discarded.
	describe('git_commit targeting a lease', () => {
		it('commits a sub-agent’s work in the lease and leaves it mergeable', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leasePath = created.path as string;
			const leaseId = created.leaseId as string;
			// The sub-agent only ever touches its own directory.
			writeFileSync(join(leasePath, 'feature.ts'), 'export const x = 1;\n');

			const res = await gitTools.get('git_commit')!.handler({
				worktree: leaseId,
				paths: 'all',
				subject: 'feature: add x'
			});

			expect(res.ok).toBe(true);
			if (!res.ok) return;
			// The commit landed in the lease, not in the conversation's workspace.
			expect(git(leasePath, ['log', '-1', '--format=%s'])).toBe('feature: add x');
			expect(git(source, ['log', '-1', '--format=%s'])).toBe('initial');
			expect(existsSync(join(source, 'feature.ts'))).toBe(false);
			// The nudge names the call that collects it — `git_worktree_merge`
			// would act on the session's own workspace and miss the lease.
			expect(res.followUpHint).toContain(`worktree_merge (leaseId: "${leaseId}")`);

			// Acceptance: the orchestrator now sees work waiting, and can take it.
			const listed = payload(await tools.get('worktree_list')!.handler({}));
			const row = (listed.worktrees as Array<Record<string, unknown>>)[0];
			expect(row.ahead).toBe(1);
			expect(row.dirtyCount).toBe(0);

			const merged = payload(await tools.get('worktree_merge')!.handler({ leaseId }));
			expect(merged.merged).toBe(true);
			expect(existsSync(join(source, 'feature.ts'))).toBe(true);
		});

		it('commits explicitly named paths relative to the lease', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leasePath = created.path as string;
			writeFileSync(join(leasePath, 'wanted.ts'), 'yes\n');
			writeFileSync(join(leasePath, 'unwanted.ts'), 'no\n');

			const res = await gitTools.get('git_commit')!.handler({
				worktree: created.leaseId as string,
				paths: ['wanted.ts'],
				subject: 'feature: only the wanted file'
			});

			expect(res.ok).toBe(true);
			expect(git(leasePath, ['show', '--name-only', '--format=', 'HEAD'])).toBe('wanted.ts');
			expect(git(leasePath, ['status', '--porcelain'])).toContain('unwanted.ts');
		});

		it('refuses to commit into a lease this conversation does not hold', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			writeFileSync(join(created.path as string, 'feature.ts'), 'export const x = 1;\n');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const other = convs.create(userId, {
				id: convs.newId(),
				title: 'other',
				workdir: source,
				model: 'test-model',
				workspaceKind: 'shared',
				workspaceKey: source
			});
			const { buildGitTools } = await import('../src/lib/server/tools/git');
			const otherTools = new Map(
				buildGitTools(source, { userId, conversationId: other.id }).map((t) => [t.name, t])
			);

			const res = await otherTools.get('git_commit')!.handler({
				worktree: created.leaseId as string,
				paths: 'all',
				subject: 'not mine'
			});

			expect(res).toMatchObject({ ok: false, error: { code: 'lease_not_found' } });
			// Nothing was committed anywhere: not in the lease, and — the failure
			// that would matter most — not in the caller's own workspace either.
			expect(git(created.path as string, ['log', '-1', '--format=%s'])).toBe('initial');
			expect(git(source, ['log', '-1', '--format=%s'])).toBe('initial');
		});

		// The lock is only worth taking if a commit and a merge agree on the KEY.
		// A mismatched key looks exactly like locking while excluding nothing —
		// silent and timing-dependent — so assert the shared key directly, and
		// that a commit really does queue behind a held lock.
		it('serializes a lease commit against the repository lock', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leasePath = created.path as string;
			writeFileSync(join(leasePath, 'feature.ts'), 'export const x = 1;\n');

			const { repositoryLockKey } = await import('../src/lib/server/git');
			const { withRepositoryLock } = await import('../src/lib/server/repo-lock');
			// Main checkout and lease share one key: that is what makes a commit in
			// the lease exclude a merge or worktree removal in the same repository.
			const leaseKey = await repositoryLockKey(leasePath);
			expect(await repositoryLockKey(source)).toBe(leaseKey);

			let releaseHolder!: () => void;
			const held = new Promise<void>((r) => (releaseHolder = r));
			let committed = false;
			const holder = withRepositoryLock(leaseKey, () => held);
			await new Promise((r) => setTimeout(r, 0));

			const commit = gitTools
				.get('git_commit')!
				.handler({
					worktree: created.leaseId as string,
					paths: 'all',
					subject: 'feature: add x'
				})
				.then((res) => {
					committed = true;
					return res;
				});

			await new Promise((r) => setTimeout(r, 50));
			expect(committed).toBe(false);

			releaseHolder();
			await holder;
			expect((await commit).ok).toBe(true);
			expect(git(leasePath, ['log', '-1', '--format=%s'])).toBe('feature: add x');
		});

		it('rejects the selector when the session context is unavailable', async () => {
			const { buildGitTools } = await import('../src/lib/server/tools/git');
			const bare = new Map(buildGitTools(source).map((t) => [t.name, t]));
			expect(
				await bare.get('git_commit')!.handler({
					worktree: 'anything',
					paths: 'all',
					subject: 'nope'
				})
			).toMatchObject({ ok: false, error: { code: 'worktree_unavailable' } });
		});

		// The stored path is never trusted on its own — it is re-derived from
		// (userId, leaseId) and checked for containment. On the write path that
		// matters more than on the read path: a commit must never land somewhere
		// the approval dialog did not name.
		it('fails closed when the lease checkout is gone', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			rmSync(created.path as string, { recursive: true, force: true });

			const res = await gitTools.get('git_commit')!.handler({
				worktree: created.leaseId as string,
				paths: 'all',
				subject: 'into thin air'
			});

			expect(res).toMatchObject({ ok: false, error: { code: 'worktree_unavailable' } });
		});
	});

	describe('merging a lease that was never committed', () => {
		// The silent version of this is the expensive one: a no-op merge reads as
		// "nothing to do" and the orchestrator tears the worktree down believing
		// it collected the work.
		it('fails loudly and names the fix', async () => {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leaseId = created.leaseId as string;
			writeFileSync(join(created.path as string, 'a.ts'), 'one\n');
			writeFileSync(join(created.path as string, 'b.ts'), 'two\n');

			const res = await tools.get('worktree_merge')!.handler({ leaseId });

			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.error.code).toBe('worktree_dirty');
			expect(res.error.message).toContain('2 uncommitted file(s)');
			// The message must carry the exact call that unblocks it.
			expect(res.error.message).toContain(
				`git_commit { worktree: "${leaseId}", paths: "all", subject:`
			);

			// And that call does unblock it.
			const commit = await gitTools.get('git_commit')!.handler({
				worktree: leaseId,
				paths: 'all',
				subject: 'sub-agent work'
			});
			expect(commit.ok).toBe(true);
			const merged = payload(await tools.get('worktree_merge')!.handler({ leaseId }));
			expect(merged.merged).toBe(true);
			expect(existsSync(join(source, 'a.ts'))).toBe(true);
		});
	});

	describe('a lease left mid-merge by onConflict: "keep"', () => {
		/**
		 * Put the lease and the conversation on conflicting edits of the same
		 * file, then sync the lease with `onConflict: "keep"` so the conflict is
		 * left in the lease — the state a sub-agent is expected to resolve.
		 */
		async function conflictedLease() {
			const created = payload(await tools.get('worktree_create')!.handler({ label: 'api' }));
			const leasePath = created.path as string;
			const leaseId = created.leaseId as string;

			writeFileSync(join(leasePath, 'README.md'), 'base\nfrom the sub-agent\n');
			expect(
				(
					await gitTools
						.get('git_commit')!
						.handler({ worktree: leaseId, paths: 'all', subject: 'sub-agent edit' })
				).ok
			).toBe(true);

			writeFileSync(join(source, 'README.md'), 'base\nfrom the orchestrator\n');
			git(source, ['commit', '-q', '-am', 'orchestrator edit']);

			const res = await tools
				.get('worktree_merge')!
				.handler({ leaseId, direction: 'from-source', onConflict: 'keep' });
			expect(res).toMatchObject({ ok: false, error: { code: 'merge_conflict' } });
			return { leaseId, leasePath, res };
		}

		// The acceptance case: conflict → resolved → committed → merged, using
		// only structured tools. Before this, `commitChanges` rejected any
		// conflicted entry up front, so the lease could not be committed, could
		// not be merged (dirty), and could only be force-removed.
		it('can be resolved, committed, and merged back with structured tools alone', async () => {
			const { leaseId, leasePath, res } = await conflictedLease();

			// The failure names both ways out, with this lease's id in them.
			if (res.ok) return;
			expect(res.error.message).toContain(
				`git_commit { worktree: "${leaseId}", paths: "all", subject:`
			);
			expect(res.error.message).toContain(`git_merge_abort { worktree: "${leaseId}" }`);

			// The orchestrator can see the state from outside the lease.
			const status = payload(await gitTools.get('git_status')!.handler({ worktree: leaseId }));
			expect(status.merge).toMatchObject({ inProgress: true, conflictedPaths: ['README.md'] });

			// Committing the raw conflict is refused — that is silent corruption.
			await expect(
				gitTools.get('git_commit')!.handler({ worktree: leaseId, paths: 'all', subject: 'resolve' })
			).rejects.toThrow('unresolved conflict markers');

			// The sub-agent resolves by editing the file, then commits.
			writeFileSync(join(leasePath, 'README.md'), 'base\nfrom both\n');
			const commit = await gitTools
				.get('git_commit')!
				.handler({ worktree: leaseId, paths: 'all', subject: 'merge orchestrator edit' });
			expect(commit.ok).toBe(true);
			expect(commit.ok && (commit.result as { mergeCommit: boolean }).mergeCommit).toBe(true);

			// The lease is clean again, so it is mergeable — and the merge lands
			// the resolution in the conversation's own workspace.
			const leaseStatus = payload(await tools.get('worktree_status')!.handler({ leaseId }));
			expect(leaseStatus.dirtyCount).toBe(0);
			const merged = payload(
				await tools.get('worktree_merge')!.handler({ leaseId, allowMergeCommit: true })
			);
			expect(merged.merged).toBe(true);
			expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('base\nfrom both\n');
		});

		it('can be abandoned with git_merge_abort, leaving the lease mergeable', async () => {
			const { leaseId, leasePath } = await conflictedLease();

			const aborted = await gitTools.get('git_merge_abort')!.handler({ worktree: leaseId });
			expect(aborted.ok).toBe(true);
			// Back to the sub-agent's own commit, with nothing left in the tree.
			expect(readFileSync(join(leasePath, 'README.md'), 'utf8')).toBe('base\nfrom the sub-agent\n');
			const status = payload(await gitTools.get('git_status')!.handler({ worktree: leaseId }));
			expect(status.merge).toMatchObject({ inProgress: false, conflictedPaths: [] });

			// Not merely "not stuck": the lease is clean and its own commit is
			// still there to collect. Collecting it conflicts again — the edits
			// really are incompatible — but the SHARED checkout is rolled back and
			// reported without the mid-merge advice, because nothing is left mid-merge.
			const leaseStatus = payload(await tools.get('worktree_status')!.handler({ leaseId }));
			expect(leaseStatus).toMatchObject({ dirtyCount: 0, ahead: 1 });
			const collect = await tools
				.get('worktree_merge')!
				.handler({ leaseId, allowMergeCommit: true });
			expect(collect).toMatchObject({ ok: false, error: { code: 'merge_conflict' } });
			expect(collect.ok || collect.error.message).not.toContain('git_merge_abort');
			expect(git(source, ['status', '--porcelain'])).toBe('');
		});
	});
});
