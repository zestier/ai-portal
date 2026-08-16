import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from '../../helpers/env';
import { makeTmpDir } from '../../helpers/tmp';
import { conversationId as convCodec } from '../../../src/lib/ids';
import type { PortalTool, ToolResult } from '../../../src/lib/server/tools/types';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-wt-tool-source-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

function result(r: ToolResult): Record<string, unknown> {
	if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`);
	return r.result as Record<string, unknown>;
}

describe('worktree tools', () => {
	let source: string;
	let userId: number;
	let conversationId: number;
	let tools: Map<string, PortalTool>;

	async function tool(name: string): Promise<PortalTool> {
		const t = tools.get(name);
		if (!t) throw new Error(`missing tool ${name}`);
		return t;
	}

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-wt-tools-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		process.env.WORKTREE_ROOT = join(dataDir, 'worktrees');
		await resetServerSingletons();
		vi.resetModules();

		const users = await import('../../../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
		const convs = await import('../../../src/lib/server/db/repos/conversations');
		const conv = convs.create(userId, {
			title: 'orchestrator',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		});
		conversationId = convCodec.parse(conv.id);

		const { buildWorktreeTools } = await import('../../../src/lib/server/tools/worktree');
		tools = new Map(buildWorktreeTools({ userId, conversationId }).map((t) => [t.name, t]));
	});

	it('exposes exactly the five worktree tools', () => {
		expect([...tools.keys()].sort()).toEqual([
			'worktree_create',
			'worktree_list',
			'worktree_merge',
			'worktree_remove',
			'worktree_status'
		]);
	});

	it('creates a worktree and reports a usable absolute path', async () => {
		const create = await tool('worktree_create');
		const res = await create.handler({ label: 'api' });
		const payload = result(res);

		expect(existsSync(payload.path as string)).toBe(true);
		expect(payload.branch).toMatch(/^portal\/lease\/.*--api$/);
		expect(payload.dirtyCount).toBe(0);
	});

	it('tells the orchestrator the directory already exists and is writable', async () => {
		// The Phase 0 spike showed sub-agents cannot reliably create directories
		// outside their allowed roots, so this hint is load-bearing, not decoration.
		const create = await tool('worktree_create');
		const res = await create.handler({ label: 'api' });
		if (!res.ok) throw new Error('expected ok');

		expect(res.followUpHint).toContain('already exists and is writable');
		expect(res.followUpHint).toMatch(/absolute path/i);
		expect(res.followUpHint).toContain('Do not point two sub-agents at the same worktree');
	});

	it('rejects a malformed label instead of silently rewriting it', async () => {
		const create = await tool('worktree_create');
		const res = await create.handler({ label: 'Not A Slug' });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('invalid_identifier');
	});

	it('reports the quota as a coded error the model can act on', async () => {
		process.env.WORKTREE_MAX_LEASES_PER_CONVERSATION = '1';
		const { resetConfigForTests } = await import('../../../src/lib/server/config');
		resetConfigForTests();

		const create = await tool('worktree_create');
		await create.handler({ label: 'one' });
		const res = await create.handler({ label: 'two' });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('lease_quota_exceeded');
		delete process.env.WORKTREE_MAX_LEASES_PER_CONVERSATION;
	});

	it('lists held worktrees with their dirty counts', async () => {
		const create = await tool('worktree_create');
		const created = result(await create.handler({ label: 'api' }));
		writeFileSync(join(created.path as string, 'wip.txt'), 'x\n');

		const list = await tool('worktree_list');
		const payload = result(await list.handler({}));
		const rows = payload.worktrees as Array<Record<string, unknown>>;

		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('api');
		expect(rows[0].dirtyCount).toBe(1);
	});

	it('refuses to remove a dirty worktree without force', async () => {
		const create = await tool('worktree_create');
		const created = result(await create.handler({ label: 'api' }));
		writeFileSync(join(created.path as string, 'wip.txt'), 'x\n');

		const remove = await tool('worktree_remove');
		const res = await remove.handler({ leaseId: created.leaseId });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('worktree_dirty');
		// The message must tell the model how to proceed deliberately.
		expect(res.error.message).toMatch(/force/);
		expect(existsSync(created.path as string)).toBe(true);
	});

	it('always prompts before removing, since force destroys work', async () => {
		const remove = await tool('worktree_remove');
		expect(remove.permissionBehavior).toBe('always-prompt');
	});

	it('always prompts before merging, since the target can be the shared checkout', async () => {
		// For a shared-workdir conversation the merge target IS the main
		// checkout, i.e. the same tree `git_worktree_merge` gates.
		const merge = await tool('worktree_merge');
		expect(merge.permissionBehavior).toBe('always-prompt');
	});

	it('keeps an unmerged branch and says so when removing', async () => {
		const create = await tool('worktree_create');
		const created = result(await create.handler({ label: 'api' }));
		const path = created.path as string;
		writeFileSync(join(path, 'feature.txt'), 'real work\n');
		git(path, ['add', 'feature.txt']);
		git(path, ['commit', '-q', '-m', 'feature']);

		const remove = await tool('worktree_remove');
		const res = await remove.handler({ leaseId: created.leaseId });
		const payload = result(res);

		expect(payload.branchDeleted).toBe(false);
		expect(existsSync(path)).toBe(false);
		if (!res.ok) return;
		expect(res.followUpHint).toContain('unmerged');
		expect(git(source, ['branch', '--list', payload.branch as string])).toContain(
			payload.branch as string
		);
	});

	it('refuses to address a worktree held by another conversation', async () => {
		const create = await tool('worktree_create');
		const created = result(await create.handler({ label: 'api' }));

		const { buildWorktreeTools } = await import('../../../src/lib/server/tools/worktree');
		const convs = await import('../../../src/lib/server/db/repos/conversations');
		const other = convs.create(userId, {
			title: 'other',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		});
		const otherTools = new Map(
			buildWorktreeTools({ userId, conversationId: convCodec.parse(other.id) }).map((t) => [
				t.name,
				t
			])
		);

		const status = otherTools.get('worktree_status')!;
		const res = await status.handler({ leaseId: created.leaseId });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.code).toBe('lease_not_found');
	});

	it('never accepts a source repository from tool arguments', async () => {
		// Accepting one would make this group an ALLOWED_WORKDIRS bypass.
		const create = await tool('worktree_create');
		const params = create.parameters as { properties: Record<string, unknown> };
		expect(Object.keys(params.properties).sort()).toEqual(['baseRef', 'label']);
	});

	describe('worktree_merge', () => {
		it('merges committed work back and tells the agent to clean up', async () => {
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			const path = created.path as string;
			writeFileSync(join(path, 'done.txt'), 'work\n');
			git(path, ['add', 'done.txt']);
			git(path, ['commit', '-q', '-m', 'done']);

			const res = await (await tool('worktree_merge')).handler({ leaseId: created.leaseId });
			const payload = result(res);

			expect(payload.merged).toBe(true);
			// A shared-workdir conversation's counterpart IS the checkout.
			expect(existsSync(join(source, 'done.txt'))).toBe(true);
			if (!res.ok) return;
			expect(res.followUpHint).toContain('worktree_remove');
		});

		it('surfaces the fast-forward failure with actionable advice', async () => {
			const create = await tool('worktree_create');
			const alpha = result(await create.handler({ label: 'alpha' }));
			const beta = result(await create.handler({ label: 'beta' }));
			for (const [lease, name] of [
				[alpha, 'alpha'],
				[beta, 'beta']
			] as const) {
				const p = lease.path as string;
				writeFileSync(join(p, `${name}.txt`), `${name}\n`);
				git(p, ['add', `${name}.txt`]);
				git(p, ['commit', '-q', '-m', name]);
			}

			const merge = await tool('worktree_merge');
			await merge.handler({ leaseId: alpha.leaseId });
			const blocked = await merge.handler({ leaseId: beta.leaseId });

			expect(blocked.ok).toBe(false);
			if (blocked.ok) return;
			expect(blocked.error.code).toBe('not_fast_forwardable');
			// The model must be told how to proceed, not just that it failed.
			expect(blocked.error.message).toContain('allowMergeCommit');

			const forced = await merge.handler({
				leaseId: beta.leaseId,
				allowMergeCommit: true
			});
			expect(forced.ok).toBe(true);
			expect(existsSync(join(source, 'beta.txt'))).toBe(true);
		});

		it('squashes a lease into one commit when asked', async () => {
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			const path = created.path as string;
			for (const name of ['one', 'two', 'three']) {
				writeFileSync(join(path, `${name}.txt`), `${name}\n`);
				git(path, ['add', `${name}.txt`]);
				git(path, ['commit', '-q', '-m', `wip ${name}`]);
			}

			const res = await (
				await tool('worktree_merge')
			).handler({
				leaseId: created.leaseId,
				squash: { subject: 'Land the api work' }
			});

			expect(res.ok).toBe(true);
			expect(res.summary).toContain('squashed from 3 commit(s)');
			expect(git(source, ['log', '--format=%s'])).toBe('Land the api work\ninitial');
		});

		// Collecting the second lease is the case the squash flow exists for, so
		// the refusal has to name the sync that unblocks it.
		it('points a behind lease at the from-source sync before retrying the squash', async () => {
			const create = await tool('worktree_create');
			const alpha = result(await create.handler({ label: 'alpha' }));
			const beta = result(await create.handler({ label: 'beta' }));
			for (const [lease, name] of [
				[alpha, 'alpha'],
				[beta, 'beta']
			] as const) {
				const p = lease.path as string;
				writeFileSync(join(p, `${name}.txt`), `${name}\n`);
				git(p, ['add', `${name}.txt`]);
				git(p, ['commit', '-q', '-m', name]);
			}

			const merge = await tool('worktree_merge');
			await merge.handler({ leaseId: alpha.leaseId, squash: { subject: 'Land alpha' } });
			const blocked = await merge.handler({
				leaseId: beta.leaseId,
				squash: { subject: 'Land beta' }
			});

			expect(blocked.ok).toBe(false);
			if (blocked.ok) return;
			expect(blocked.error.code).toBe('squash_behind_source');
			expect(blocked.error.message).toContain('"from-source"');

			await merge.handler({ leaseId: beta.leaseId, direction: 'from-source' });
			const retried = await merge.handler({
				leaseId: beta.leaseId,
				squash: { subject: 'Land beta' }
			});

			expect(retried.ok).toBe(true);
			expect(existsSync(join(source, 'beta.txt'))).toBe(true);
			// One commit per lease, and no merge commit from beta's sync.
			expect(git(source, ['log', '--format=%s'])).toBe('Land beta\nLand alpha\ninitial');
			expect(git(source, ['rev-list', '--merges', 'HEAD'])).toBe('');
		});

		it('reports uncommitted work rather than silently skipping it', async () => {
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			writeFileSync(join(created.path as string, 'wip.txt'), 'unsaved\n');

			const res = await (await tool('worktree_merge')).handler({ leaseId: created.leaseId });

			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.error.code).toBe('worktree_dirty');
		});

		it('refuses a worktree held by another conversation', async () => {
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			const { buildWorktreeTools } = await import('../../../src/lib/server/tools/worktree');
			const convs = await import('../../../src/lib/server/db/repos/conversations');
			const other = convs.create(userId, {
				title: 'other',
				workdir: source,
				model: 'test-model',
				workspaceKind: 'shared',
				workspaceKey: source
			});
			const otherTools = new Map(
				buildWorktreeTools({ userId, conversationId: convCodec.parse(other.id) }).map((t) => [
					t.name,
					t
				])
			);

			const res = await otherTools.get('worktree_merge')!.handler({ leaseId: created.leaseId });

			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.error.code).toBe('lease_not_found');
		});

		it('reports commits waiting to be merged in the listing', async () => {
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			const path = created.path as string;
			writeFileSync(join(path, 'done.txt'), 'work\n');
			git(path, ['add', 'done.txt']);
			git(path, ['commit', '-q', '-m', 'done']);

			const listed = result(await (await tool('worktree_list')).handler({}));
			const rows = listed.worktrees as Array<Record<string, unknown>>;

			// `ahead` is the orchestrator's cue that something is ready to collect.
			expect(rows[0].ahead).toBe(1);
		});

		it('flags a worktree whose counts could not be determined', async () => {
			// Absent counts must not read as "nothing to merge". An agent that saw a
			// bare row with no `ahead` would conclude the worktree was collected and
			// move on, silently abandoning whatever was committed in it.
			const created = result(await (await tool('worktree_create')).handler({ label: 'api' }));
			rmSync(created.path as string, { recursive: true, force: true });

			const listed = result(await (await tool('worktree_list')).handler({}));
			const row = (listed.worktrees as Array<Record<string, unknown>>)[0];

			expect(row.unavailable).toBe(true);
			expect(row.ahead).toBeUndefined();
			expect(row.dirtyCount).toBeUndefined();
		});
	});
});
