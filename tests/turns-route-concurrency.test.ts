import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { join } from 'node:path';
import { setupLocalEnv } from './helpers/env';

// The turns POST route persists a user message and then calls
// startTurnFromUserMessage. In memory mode that helper awaits pool.release()
// before the turn is registered, opening a window where two concurrent POSTs
// could both append a user message and the loser 500s with an orphaned
// message. Mock the helper with a controllable (deferred) promise so we can
// hold the first request "in flight" and fire a second concurrently, exercising
// the synchronous reservation guard.
const startTurnMock = vi.fn();
vi.mock('../src/lib/server/turn-start', () => ({
	startTurnFromUserMessage: (...args: unknown[]) => startTurnMock(...args)
}));

async function freshImports() {
	vi.resetModules();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const route = await import('../src/routes/api/conversations/[id]/turns/+server');
	return { users, convs, messages, route };
}

function jsonRequest(body: unknown): Request {
	return new Request('http://localhost/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function capture(fn: () => unknown) {
	try {
		const res = (await fn()) as Response;
		return { thrown: null as unknown, status: res.status, res };
	} catch (e) {
		return { thrown: e, status: undefined, res: undefined };
	}
}

describe('turns POST concurrency', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-turns-concurrency-');
		startTurnMock.mockReset();
	});

	it('rejects a concurrent second POST with 409 and never orphans a user message', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4'
		});

		// First call parks inside startTurnFromUserMessage (reservation held).
		let resolveStart: (turn: unknown) => void = () => {};
		startTurnMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);

		const first = capture(() =>
			route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'first' })
			} as never)
		);

		// Let the first request run up to its parked await.
		await Promise.resolve();
		await Promise.resolve();

		// Second concurrent POST must be rejected synchronously as a 409 and
		// must NOT append its message.
		const second = await capture(() =>
			route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'second' })
			} as never)
		);

		expect(isHttpError(second.thrown)).toBe(true);
		expect((second.thrown as { status: number }).status).toBe(409);
		expect(startTurnMock).toHaveBeenCalledTimes(1);

		// Release the first request and let it complete with a 200.
		resolveStart({ id: 'turn-1' });
		const firstResult = await first;
		expect(firstResult.status).toBe(200);

		// Exactly one user message persisted — the second never wrote one.
		const msgs = messages.listByConversation(conv.id).filter((m) => m.role === 'user');
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.content).toBe('first');
	});

	it('allows a fresh POST after the reservation is released', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4'
		});

		startTurnMock.mockResolvedValue({ id: 'turn-1' });
		const first = await capture(() =>
			route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'first' })
			} as never)
		);
		expect(first.status).toBe(200);

		// Reservation released in the route's finally, so a follow-up succeeds.
		startTurnMock.mockResolvedValue({ id: 'turn-2' });
		const second = await capture(() =>
			route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'second' })
			} as never)
		);
		expect(second.status).toBe(200);
		expect(startTurnMock).toHaveBeenCalledTimes(2);

		const userMsgs = messages.listByConversation(conv.id).filter((m) => m.role === 'user');
		expect(userMsgs.map((m) => m.content)).toEqual(['first', 'second']);
	});

	it('rejects an unavailable managed workspace before persisting send state', async () => {
		const dataDir = await setupLocalEnv('portal-turns-missing-worktree-');
		const { users, convs, messages, route } = await freshImports();
		const user = users.ensureLocalUser();
		const conversationId = 'MISSINGSENDWORKTREE';
		const worktreePath = join(dataDir, 'worktrees', String(user.id), conversationId);
		const conversation = convs.create(user.id, {
			title: 'New chat',
			workdir: worktreePath,
			workspaceKind: 'managed-worktree',
			workspaceKey: '/tmp/source',
			managedWorktree: {
				sourceWorkdir: '/tmp/source',
				path: worktreePath,
				gitCommonDir: '/tmp/source/.git',
				branch: `portal/${conversationId}`,
				baseSha: 'a'.repeat(40)
			},
			draftPrompt: 'keep this draft',
			model: 'gpt-4'
		});

		const result = await capture(() =>
			route.POST({
				params: { id: conversation.id },
				locals: { userId: user.id },
				request: jsonRequest({ content: 'do not persist' })
			} as never)
		);

		expect(isHttpError(result.thrown)).toBe(true);
		expect(result.thrown).toMatchObject({
			status: 409,
			body: { code: 'workspace_unavailable' }
		});
		expect(messages.listByConversation(conversation.id)).toEqual([]);
		expect(convs.get(conversation.id, user.id)).toMatchObject({
			title: 'New chat',
			draftPrompt: 'keep this draft'
		});
		expect(startTurnMock).not.toHaveBeenCalled();
	});
});
