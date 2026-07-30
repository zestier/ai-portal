// The `git_commit` approval dialog must name WHERE the commit lands.
//
// A commit into a lease touches a different checkout and a different branch than
// the conversation's own workspace, and the raw tool args carry nothing but an
// opaque ULID. Without a server-resolved snapshot the human is approving "create
// a commit" with no idea which tree receives it — and the audit row recorded for
// that decision is equally blind.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import type { PortalEvent } from '../src/lib/types';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-commit-prompt-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

describe('git_commit permission prompt names its worktree', () => {
	let source: string;
	let userId: string;
	let conversationId: string;
	let interactive: typeof import('../src/lib/server/runtime/interactive-requests');
	let settings: typeof import('../src/lib/server/db/repos/settings');
	let createLease: (label: string) => Promise<Record<string, unknown>>;
	let harnessFor: (conversationId: string) => (req: Record<string, unknown>) => Promise<unknown>;

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-commit-prompt-');
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

		interactive = await import('../src/lib/server/runtime/interactive-requests');
		settings = await import('../src/lib/server/db/repos/settings');
		const { buildWorktreeTools } = await import('../src/lib/server/tools/worktree');
		createLease = async (label: string) => {
			const tools = new Map(buildWorktreeTools({ userId, conversationId }).map((t) => [t.name, t]));
			const res = await tools.get('worktree_create')!.handler({ label });
			if (!res.ok) throw new Error(`expected ok, got ${res.error.message}`);
			return res.result as Record<string, unknown>;
		};

		const { createInteractiveCallbacks } =
			await import('../src/lib/server/copilot/interactive-adapter');
		harnessFor = (convId: string) => {
			const events: PortalEvent[] = [];
			const { onPermissionRequest } = createInteractiveCallbacks({
				conversationId: convId,
				userId,
				workingDirectory: source,
				getWorkspaceRoots: () => [source],
				policy: 'prompt',
				emit: (ev) => events.push(ev),
				getApproveAll: () => false,
				getMode: () => 'interactive',
				getSessionWorkspacePath: () => null,
				// git_commit is always-prompt in the real tool registry.
				getPermissionBehavior: () => 'always-prompt'
			});
			return onPermissionRequest;
		};
	});

	/** Raise a git_commit request and return the view the human would see. */
	async function promptFor(convId: string, args: Record<string, unknown>) {
		type PermissionView = Extract<
			ReturnType<typeof interactive.listForConversation>[number],
			{ kind: 'permission' }
		>;
		const onPermissionRequest = harnessFor(convId);
		const pending = onPermissionRequest({ kind: 'custom', toolName: 'git_commit', args });
		let view: PermissionView | undefined;
		for (let i = 0; i < 500 && !view; i++) {
			view = interactive
				.listForConversation(convId)
				.find((r): r is PermissionView => r.kind === 'permission');
			if (!view) await new Promise((r) => setTimeout(r, 1));
		}
		if (!view) throw new Error('no human prompt was raised');
		interactive.resolve(view.requestId, userId, {
			kind: 'permission',
			decision: 'allow-once'
		});
		await pending;
		return view;
	}

	it('resolves the lease into label, branch, and path', async () => {
		const lease = await createLease('api');

		const view = await promptFor(conversationId, {
			worktree: lease.leaseId,
			paths: 'all',
			subject: 'feature: add x'
		});

		expect(view.commitTarget).toEqual({
			leaseId: lease.leaseId,
			label: 'api',
			branch: lease.branch,
			path: lease.path
		});
		expect(view.summary).toContain(`Destination: worktree api on branch ${lease.branch}`);
	});

	it('omits the target for a commit into the conversation workspace', async () => {
		const view = await promptFor(conversationId, { paths: 'all', subject: 'local work' });

		expect(view.commitTarget).toBeUndefined();
		expect(view.summary).toContain("Destination: This conversation's workspace");
	});

	// The dialog must not leak another conversation's lease metadata, but it also
	// must not silently present the request as a local commit — the id is shown
	// bare so the human sees a worktree was targeted.
	it('shows only the raw id for a lease this conversation does not hold', async () => {
		const lease = await createLease('api');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const other = convs.create(userId, {
			id: convs.newId(),
			title: 'other',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		});

		const view = await promptFor(other.id, {
			worktree: lease.leaseId,
			paths: 'all',
			subject: 'not mine'
		});

		expect(view.commitTarget).toEqual({ leaseId: lease.leaseId });
		expect(view.summary).toContain(`Destination: worktree ${lease.leaseId}`);
		expect(view.summary).not.toContain(lease.branch as string);
	});

	// The tool's schema trims the selector before resolving it. Resolving the raw
	// value here would render a padded-but-valid id as unresolved — the same way
	// a foreign lease renders — while the commit itself lands in the real
	// worktree. Prompt and execution must agree on which lease is meant.
	it('resolves a padded lease id the same way the tool does', async () => {
		const lease = await createLease('api');

		const view = await promptFor(conversationId, {
			worktree: `  ${lease.leaseId}  `,
			paths: 'all',
			subject: 'feature: add x'
		});

		expect(view.commitTarget).toMatchObject({ leaseId: lease.leaseId, label: 'api' });
		expect(view.summary).toContain(`Destination: worktree api on branch ${lease.branch}`);
	});

	// The audit trail is the human's after-the-fact record of what was approved;
	// it is built from the same summary and must carry the destination too.
	it('records the destination in the permission audit row', async () => {
		const lease = await createLease('api');
		await promptFor(conversationId, {
			worktree: lease.leaseId,
			paths: 'all',
			subject: 'feature: add x'
		});

		const decisions = settings
			.listRecentDecisionsForUser(userId)
			.filter((d) => d.conversationId === conversationId);
		expect(decisions.some((d) => (d.argsSummary ?? '').includes('Destination: worktree api'))).toBe(
			true
		);
	});
});
