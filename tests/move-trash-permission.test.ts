import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import type { PortalEvent } from '../src/lib/types';

// `move` and `trash` route their permission through the shared interactive
// adapter as filesystem `write` requests on derived paths. These tests verify
// the wiring end to end against the real grant store: an in-workspace op is
// covered by the standard session-workspace fs-write SEED (no new seed) and
// auto-approves with no dialog, while a path that escapes the workspace does
// NOT auto-approve. For `move`, the two-path gate means an out-of-workspace
// source OR destination must prompt.

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

	const workspaceRoot = makeTmpDir('move-trash-adapter-');
	const conversationId = `conv-mt-${Math.random().toString(36).slice(2)}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'move/trash test',
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

async function waitForPrompt(
	harness: Awaited<ReturnType<typeof makeHarness>>
): Promise<{ requestId: string }> {
	for (let i = 0; i < 200; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) return pending[0] as { requestId: string };
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error('expected a permission prompt');
}

describe('move permission wiring', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-move-trash-');
	});

	it('auto-approves an in-workspace move with no dialog (covered by the fs-write seed)', async () => {
		const harness = await makeHarness('interactive');
		const result = await harness.onPermissionRequest(
			request('move', { source: 'a.txt', destination: 'sub/b.txt' })
		);
		expect(result).toEqual({ kind: 'approve-once' });
		expect(harness.events.some((e) => e.type === 'interactive.request')).toBe(false);
		expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
	});

	it('does NOT auto-approve when the DESTINATION escapes the workspace', async () => {
		const harness = await makeHarness('interactive');
		const outside = makeTmpDir('move-adapter-dst-');
		const resultPromise = harness.onPermissionRequest(
			request('move', { source: 'a.txt', destination: join(outside, 'evil') })
		);
		const view = await waitForPrompt(harness);
		harness.interactive.resolve(view.requestId, harness.user.id, {
			kind: 'permission',
			decision: 'deny'
		});
		expect(await resultPromise).toMatchObject({ kind: 'reject' });
	});

	it('does NOT auto-approve when the SOURCE escapes the workspace', async () => {
		const harness = await makeHarness('interactive');
		const outside = makeTmpDir('move-adapter-src-');
		const resultPromise = harness.onPermissionRequest(
			request('move', { source: join(outside, 'secret'), destination: 'b.txt' })
		);
		const view = await waitForPrompt(harness);
		harness.interactive.resolve(view.requestId, harness.user.id, {
			kind: 'permission',
			decision: 'deny'
		});
		expect(await resultPromise).toMatchObject({ kind: 'reject' });
	});

	it('auto-rejects an out-of-workspace move in best-effort mode (no dialog)', async () => {
		const harness = await makeHarness('best-effort');
		const result = await harness.onPermissionRequest(
			request('move', { source: 'a.txt', destination: '../escape.txt' })
		);
		expect(result).toMatchObject({ kind: 'reject' });
		expect(harness.events.some((e) => e.type === 'interactive.request')).toBe(false);
	});
});

describe('trash permission wiring', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-move-trash-');
	});

	it('auto-approves an in-workspace trash with no dialog (delete inherits the write seed)', async () => {
		const harness = await makeHarness('interactive');
		const result = await harness.onPermissionRequest(request('trash', { path: 'a.txt' }));
		expect(result).toEqual({ kind: 'approve-once' });
		expect(harness.events.some((e) => e.type === 'interactive.request')).toBe(false);
	});

	it('does NOT auto-approve trashing an out-of-workspace path', async () => {
		const harness = await makeHarness('interactive');
		const outside = makeTmpDir('trash-adapter-outside-');
		const resultPromise = harness.onPermissionRequest(
			request('trash', { path: join(outside, 'secret') })
		);
		const view = await waitForPrompt(harness);
		harness.interactive.resolve(view.requestId, harness.user.id, {
			kind: 'permission',
			decision: 'deny'
		});
		expect(await resultPromise).toMatchObject({ kind: 'reject' });
	});

	it('the approved in-workspace trash, once run, moves the file into .trash', async () => {
		const harness = await makeHarness('interactive');
		writeFileSync(join(harness.workspaceRoot, 'a.txt'), 'bye');
		const result = await harness.onPermissionRequest(request('trash', { path: 'a.txt' }));
		expect(result).toEqual({ kind: 'approve-once' });
		const tool = harness.tools.find((t) => t.name === 'trash')!;
		const run = await tool.handler({ path: 'a.txt' });
		expect(run.ok).toBe(true);
		expect(existsSync(join(harness.workspaceRoot, 'a.txt'))).toBe(false);
		expect(existsSync(join(harness.workspaceRoot, '.trash'))).toBe(true);
	});

	it('the approved in-workspace move, once run, relocates the file', async () => {
		const harness = await makeHarness('interactive');
		mkdirSync(join(harness.workspaceRoot, 'sub'), { recursive: true });
		writeFileSync(join(harness.workspaceRoot, 'a.txt'), 'x');
		const result = await harness.onPermissionRequest(
			request('move', { source: 'a.txt', destination: 'sub/b.txt' })
		);
		expect(result).toEqual({ kind: 'approve-once' });
		const tool = harness.tools.find((t) => t.name === 'move')!;
		const run = await tool.handler({ source: 'a.txt', destination: 'sub/b.txt' });
		expect(run.ok).toBe(true);
		expect(existsSync(join(harness.workspaceRoot, 'sub/b.txt'))).toBe(true);
		expect(existsSync(join(harness.workspaceRoot, 'a.txt'))).toBe(false);
	});
});
