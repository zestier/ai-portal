import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

// GET /api/conversations/[id]/search wires the FTS searchConversation to a
// lightweight jump-target payload (message id + preview).

async function seed() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const user = users.ensureLocalUser();
	const conv = convs.create(user.id, { title: 'search', workdir: '/tmp', model: null });
	const m = messages.append(conv.id, {
		role: 'user',
		content: 'the needle-find-abc123 query goes here'
	});
	messages.append(conv.id, { role: 'assistant', content: 'Stubbed reply to: hello' });
	return { conv, m, user };
}

function makeEvent(convId: string, q: string | null, userId: number | null) {
	const url = new URL(`http://127.0.0.1/api/conversations/${convId}/search?q=${q ?? ''}`);
	return {
		params: { id: convId },
		locals: { userId },
		url
	};
}

async function callGet(convId: string, q: string | null, userId: number | null) {
	const { GET } = await import('../src/routes/api/conversations/[id]/search/+server');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (GET as any)(makeEvent(convId, q, userId));
}

describe('conversation search endpoint', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-search-route-');
	});

	it('returns jump targets for an FTS hit', async () => {
		const { conv, m, user } = await seed();
		const res = await callGet(conv.id, 'needle-find-abc123', user.id);
		const body = await res.json();
		expect(body.results.length).toBeGreaterThan(0);
		const hit = body.results.find((r: { messageId: string }) => r.messageId === m.id);
		expect(hit).toBeTruthy();
		expect(hit.preview).toContain('needle-find-abc123');
		expect(hit.role).toBe('user');
	});

	it('returns an empty result list for a blank query', async () => {
		const { conv, user } = await seed();
		const res = await callGet(conv.id, '', user.id);
		const body = await res.json();
		expect(body.results).toEqual([]);
	});
});
