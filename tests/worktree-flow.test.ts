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
import { existsSync, writeFileSync } from 'node:fs';
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
});
