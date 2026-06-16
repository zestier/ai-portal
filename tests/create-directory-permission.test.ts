import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import type { PortalEvent } from '../src/lib/types';

// create_directory routes its permission through the shared interactive adapter
// as a filesystem `write` on the derived path. These tests verify the wiring
// end to end against the real grant store: an in-workspace create is covered by
// the standard session-workspace fs-write SEED (no new seed) and auto-approves
// with no dialog, while an out-of-workspace path does NOT auto-approve.

async function makeHarness(mode: 'interactive' | 'best-effort' = 'interactive') {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const { ensureSeedGrantsForUser } = await import('../src/lib/server/permissions/seed-grants');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const { buildFilesystemTools } = await import('../src/lib/server/tools/filesystem');
	const { buildPermissionRequestResolver } = await import('../src/lib/server/tools/types');

	const user = ensureLocalUser();
	ensureSeedGrantsForUser(user.id);

	const workspaceRoot = makeTmpDir('create-dir-adapter-');
	const conversationId = `conv-cd-${Math.random().toString(36).slice(2)}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'create_directory test',
		workdir: workspaceRoot,
		model: 'gpt-4'
	});

	const events: PortalEvent[] = [];
	const tools = buildFilesystemTools(workspaceRoot);
	const { onPermissionRequest } = createInteractiveCallbacks({
		conversationId,
		userId: user.id,
		workingDirectory: workspaceRoot,
		policy: 'prompt',
		emit: (ev) => events.push(ev),
		getApproveAll: () => false,
		getMode: () => mode,
		getSessionWorkspacePath: () => workspaceRoot,
		getPermissionBehavior: () => 'normal',
		derivePermissionRequest: buildPermissionRequestResolver(tools)
	});

	return { interactive, user, conversationId, workspaceRoot, events, onPermissionRequest, tools };
}

function request(toolName: string, args: unknown) {
	return { kind: 'custom-tool', toolName, args } as Record<string, unknown>;
}

describe('create_directory permission wiring', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-create-dir-');
	});

	it('auto-approves an in-workspace create with no dialog (covered by the fs-write seed)', async () => {
		const harness = await makeHarness('interactive');
		const result = await harness.onPermissionRequest(
			request('create_directory', { path: 'src/new' })
		);
		expect(result).toEqual({ kind: 'approve-once' });
		// No interactive prompt was raised.
		expect(harness.events.some((e) => e.type === 'interactive.request')).toBe(false);
		expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
	});

	it('does NOT auto-approve an out-of-workspace path: it raises a prompt', async () => {
		const harness = await makeHarness('interactive');
		const outside = makeTmpDir('create-dir-adapter-outside-');
		const resultPromise = harness.onPermissionRequest(
			request('create_directory', { path: join(outside, 'evil') })
		);

		let view: { requestId: string } | undefined;
		for (let i = 0; i < 200 && !view; i++) {
			const pending = harness.interactive.listForConversation(harness.conversationId);
			if (pending.length > 0) {
				view = pending[0] as { requestId: string };
				break;
			}
			await new Promise((r) => setTimeout(r, 1));
		}
		expect(view, 'expected a permission prompt for the out-of-workspace path').toBeTruthy();

		harness.interactive.resolve(view!.requestId, harness.user.id, {
			kind: 'permission',
			decision: 'deny'
		});
		const result = await resultPromise;
		expect(result).toMatchObject({ kind: 'reject' });
	});

	it('auto-rejects an out-of-workspace path in best-effort mode (no dialog)', async () => {
		const harness = await makeHarness('best-effort');
		const result = await harness.onPermissionRequest(
			request('create_directory', { path: '../escape' })
		);
		expect(result).toMatchObject({ kind: 'reject' });
		expect(harness.events.some((e) => e.type === 'interactive.request')).toBe(false);
	});

	it('the approved in-workspace request, once run, actually creates the directory', async () => {
		const harness = await makeHarness('interactive');
		const result = await harness.onPermissionRequest(request('create_directory', { path: 'a/b' }));
		expect(result).toEqual({ kind: 'approve-once' });
		const tool = harness.tools.find((t) => t.name === 'create_directory')!;
		const run = await tool.handler({ path: 'a/b' });
		expect(run.ok).toBe(true);
		expect(existsSync(join(harness.workspaceRoot, 'a/b'))).toBe(true);
		expect(statSync(join(harness.workspaceRoot, 'a/b')).isDirectory()).toBe(true);
	});
});
