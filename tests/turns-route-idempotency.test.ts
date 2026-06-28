import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { setupLocalEnv } from './helpers/env';

// The turns POST route dedupes retried sends via an idempotency key (the
// `Idempotency-Key` header or `requestId` in the body). Mock the turn starter
// so we can assert how many turns were actually started and that a retry
// replays the original ids instead of creating a second message/turn.
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

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request('http://localhost/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body)
	});
}

async function post(
	route: Awaited<ReturnType<typeof freshImports>>['route'],
	convId: string,
	userId: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = (await route.POST({
		params: { id: convId },
		locals: { userId },
		request: jsonRequest(body, headers)
	} as never)) as Response;
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('turns POST idempotency', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-turns-idempotency-');
		startTurnMock.mockReset();
	});

	it('replays the original ids for a repeated Idempotency-Key header', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		let turnSeq = 0;
		startTurnMock.mockImplementation(() => Promise.resolve({ id: `turn-${++turnSeq}` }));

		const first = await post(
			route,
			conv.id,
			u.id,
			{ content: 'hello' },
			{ 'idempotency-key': 'k1' }
		);
		expect(first.status).toBe(200);
		expect(first.json.turnId).toBe('turn-1');
		const firstMsgId = first.json.userMessageId;

		// Same key again → original ids, no new turn, no new message.
		const second = await post(
			route,
			conv.id,
			u.id,
			{ content: 'hello again' },
			{ 'idempotency-key': 'k1' }
		);
		expect(second.status).toBe(200);
		expect(second.json.turnId).toBe('turn-1');
		expect(second.json.userMessageId).toBe(firstMsgId);

		expect(startTurnMock).toHaveBeenCalledTimes(1);
		const userMsgs = messages.listByConversation(conv.id).filter((m) => m.role === 'user');
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0]!.content).toBe('hello');
	});

	it('dedupes via a body requestId too', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		startTurnMock.mockResolvedValue({ id: 'turn-1' });

		const first = await post(route, conv.id, u.id, { content: 'hi', requestId: 'req-1' });
		const second = await post(route, conv.id, u.id, { content: 'hi', requestId: 'req-1' });

		expect(first.json.userMessageId).toBe(second.json.userMessageId);
		expect(second.json.turnId).toBe('turn-1');
		expect(startTurnMock).toHaveBeenCalledTimes(1);
		expect(messages.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(1);
	});

	it('starts distinct turns for distinct keys', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		let turnSeq = 0;
		startTurnMock.mockImplementation(() => Promise.resolve({ id: `turn-${++turnSeq}` }));

		const first = await post(route, conv.id, u.id, { content: 'a' }, { 'idempotency-key': 'k1' });
		const second = await post(route, conv.id, u.id, { content: 'b' }, { 'idempotency-key': 'k2' });

		expect(first.json.turnId).toBe('turn-1');
		expect(second.json.turnId).toBe('turn-2');
		expect(first.json.userMessageId).not.toBe(second.json.userMessageId);
		expect(startTurnMock).toHaveBeenCalledTimes(2);
		expect(messages.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(2);
	});

	it('does not dedupe when no key is supplied', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		let turnSeq = 0;
		startTurnMock.mockImplementation(() => Promise.resolve({ id: `turn-${++turnSeq}` }));

		await post(route, conv.id, u.id, { content: 'a' });
		await post(route, conv.id, u.id, { content: 'b' });

		expect(startTurnMock).toHaveBeenCalledTimes(2);
		expect(messages.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(2);
	});

	it('replays the original ids after the original turn started (still running)', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		// The first request returns once the turn is started (the returned turn
		// is 'running'); its reservation is released in the route's finally. A
		// retry arriving after that — the lost-response case — must replay the
		// original ids via the pre-reservation idempotency lookup rather than
		// hit the running-turn 409 guard.
		startTurnMock.mockResolvedValueOnce({ id: 'turn-1' });
		const first = await post(route, conv.id, u.id, { content: 'go' }, { 'idempotency-key': 'k1' });
		expect(first.json.turnId).toBe('turn-1');

		const retry = await post(route, conv.id, u.id, { content: 'go' }, { 'idempotency-key': 'k1' });
		expect(retry.status).toBe(200);
		expect(retry.json.turnId).toBe('turn-1');
		expect(retry.json.userMessageId).toBe(first.json.userMessageId);
		expect(startTurnMock).toHaveBeenCalledTimes(1);
		expect(messages.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(1);
	});

	it('does not duplicate when a same-key retry races the original mid-start (409 boundary)', async () => {
		const { users, convs, messages, route } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});

		// Park the first request inside startTurn (before the idempotency row is
		// recorded), then fire a same-key retry concurrently. The row isn't
		// written yet, so the retry falls through to the reservation guard and
		// gets a 409 — the boundary case. Crucially it must NOT append a second
		// user message.
		let resolveStart: (turn: unknown) => void = () => {};
		startTurnMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				})
		);

		const first = (async () =>
			(await route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'go' }, { 'idempotency-key': 'k1' })
			} as never)) as Response)();

		await Promise.resolve();
		await Promise.resolve();

		let retryStatus: number | undefined;
		try {
			await route.POST({
				params: { id: conv.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'go' }, { 'idempotency-key': 'k1' })
			} as never);
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			retryStatus = (e as { status: number }).status;
		}
		expect(retryStatus).toBe(409);

		resolveStart({ id: 'turn-1' });
		const firstRes = await first;
		expect(firstRes.status).toBe(200);

		expect(startTurnMock).toHaveBeenCalledTimes(1);
		expect(messages.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(1);
	});
});
