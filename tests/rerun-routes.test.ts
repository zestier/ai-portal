import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { setupLocalEnv } from './helpers/env';

// The /edit and /regenerate routes call startTurnFromUserMessage AFTER the
// (synchronous) message-edit work. Mock it so we can drive the "unexpected
// failure while starting the rerun turn" path and assert the route maps it to
// a clear client error instead of leaking a bare SvelteKit 500.
const startTurnMock = vi.fn();
vi.mock('../src/lib/server/turn-start', () => ({
	startTurnFromUserMessage: (...args: unknown[]) => startTurnMock(...args)
}));

async function freshImports() {
	vi.resetModules();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const editRoute =
		await import('../src/routes/api/conversations/[id]/messages/[messageId]/edit/+server');
	const regenRoute =
		await import('../src/routes/api/conversations/[id]/messages/[messageId]/regenerate/+server');
	return { users, convs, messages, editRoute, regenRoute };
}

function jsonRequest(body: unknown): Request {
	return new Request('http://localhost/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function callAndCapture(fn: () => unknown) {
	try {
		const res = (await fn()) as Response;
		return { thrown: null as unknown, status: res.status };
	} catch (e) {
		return { thrown: e, status: undefined };
	}
}

describe('rerun routes: error surfacing', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-rerun-route-');
		startTurnMock.mockReset();
	});

	it('/edit maps an unexpected turn-start failure to a clear 502, not a bare 500', async () => {
		const { users, convs, messages, editRoute } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});
		const u1 = messages.append(conv.id, { role: 'user', content: 'original' });

		startTurnMock.mockRejectedValue(
			new Error('Failed to open a GitHub Copilot session for conversation ' + conv.id)
		);

		const { thrown } = await callAndCapture(() =>
			editRoute.POST({
				params: { id: conv.id, messageId: u1.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'edited' })
			} as never)
		);

		expect(isHttpError(thrown)).toBe(true);
		const httpErr = thrown as { status: number; body: { message: string } };
		// A bare 500 would carry SvelteKit's generic "Internal server error".
		expect(httpErr.status).toBe(502);
		expect(httpErr.body.message).toContain("Couldn't start the rerun");
		expect(httpErr.body.message).toContain('GitHub Copilot session');
	});

	it('/edit still maps InlineEditRejected to its specific 4xx status', async () => {
		const { users, convs, messages, editRoute } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});
		// Editing an assistant message is rejected with `not_user_message` (400).
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply' });

		const { thrown } = await callAndCapture(() =>
			editRoute.POST({
				params: { id: conv.id, messageId: a1.id },
				locals: { userId: u.id },
				request: jsonRequest({ content: 'edited' })
			} as never)
		);

		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(400);
		// turn-start must never be reached for a rejected edit.
		expect(startTurnMock).not.toHaveBeenCalled();
	});

	it('/regenerate maps an unexpected turn-start failure to a clear 502', async () => {
		const { users, convs, messages, regenRoute } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'c',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});
		messages.append(conv.id, { role: 'user', content: 'q' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'a' });

		startTurnMock.mockRejectedValue(new Error('runtime connection lost'));

		const { thrown } = await callAndCapture(() =>
			regenRoute.POST({
				params: { id: conv.id, messageId: a1.id },
				locals: { userId: u.id }
			} as never)
		);

		expect(isHttpError(thrown)).toBe(true);
		const httpErr = thrown as { status: number; body: { message: string } };
		expect(httpErr.status).toBe(502);
		expect(httpErr.body.message).toContain("Couldn't start the rerun");
		expect(httpErr.body.message).toContain('runtime connection lost');
	});
});
