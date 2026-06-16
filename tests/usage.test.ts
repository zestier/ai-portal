import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { makeFakeSession } from './helpers/fake-session';

const acquireMock = vi.fn();
vi.mock('../src/lib/server/runtime/pool', () => ({
	acquire: (...args: unknown[]) => acquireMock(...args),
	registerKeepAlive: () => {}
}));

async function freshImports() {
	vi.resetModules();
	await setupLocalEnv();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const usage = await import('../src/lib/server/db/repos/usage');
	const turnRunner = await import('../src/lib/server/runtime/turn-runner');
	return { users, convs, usage, turnRunner };
}

describe('usage repo', () => {
	beforeEach(() => {
		acquireMock.mockReset();
	});

	it('upserts and reads back a context-usage snapshot', async () => {
		const { users, convs, usage } = await freshImports();
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'T', workdir: '/tmp', model: 'gpt-4' });

		expect(usage.get(conv.id)).toBeNull();

		usage.upsert(conv.id, {
			currentTokens: 1200,
			tokenLimit: 200_000,
			messagesLength: 5,
			systemTokens: 800,
			conversationTokens: 350,
			toolDefinitionsTokens: 50
		});
		const a = usage.get(conv.id);
		expect(a).not.toBeNull();
		expect(a!.currentTokens).toBe(1200);
		expect(a!.tokenLimit).toBe(200_000);
		expect(a!.messagesLength).toBe(5);
		expect(a!.systemTokens).toBe(800);
		expect(a!.conversationTokens).toBe(350);
		expect(a!.toolDefinitionsTokens).toBe(50);

		// Upsert overwrites and accepts missing breakdown.
		usage.upsert(conv.id, {
			currentTokens: 1500,
			tokenLimit: 200_000,
			messagesLength: 7
		});
		const b = usage.get(conv.id);
		expect(b!.currentTokens).toBe(1500);
		expect(b!.messagesLength).toBe(7);
		expect(b!.systemTokens).toBeNull();
		expect(b!.conversationTokens).toBeNull();
		expect(b!.toolDefinitionsTokens).toBeNull();
	});

	it('overwrites breakdown fields with null when omitted on later upsert', async () => {
		const { users, convs, usage } = await freshImports();
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'T', workdir: '/tmp', model: 'gpt-4' });
		usage.upsert(conv.id, {
			currentTokens: 1,
			tokenLimit: 100,
			messagesLength: 1,
			systemTokens: 50
		});
		expect(usage.get(conv.id)!.systemTokens).toBe(50);
		usage.upsert(conv.id, { currentTokens: 2, tokenLimit: 100, messagesLength: 1 });
		expect(usage.get(conv.id)!.systemTokens).toBeNull();
	});
});

describe('turn-runner persists context.usage', () => {
	beforeEach(() => {
		acquireMock.mockReset();
	});

	it('writes a conversation_usage row when a context.usage event flows through', async () => {
		const { users, convs, usage, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'T', workdir: '/tmp', model: 'gpt-4' });

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{
					type: 'context.usage',
					currentTokens: 4242,
					tokenLimit: 128_000,
					messagesLength: 3,
					systemTokens: 1000,
					conversationTokens: 3200,
					toolDefinitionsTokens: 42,
					isInitial: false
				},
				{ type: 'message.delta', messageId: 'm1', text: 'hello' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: '/tmp',
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		// The event was forwarded to subscribers verbatim.
		const ctx = received.find((e) => e.type === 'context.usage');
		expect(ctx).toBeTruthy();

		// And persisted.
		const row = usage.get(conv.id);
		expect(row).not.toBeNull();
		expect(row!.currentTokens).toBe(4242);
		expect(row!.tokenLimit).toBe(128_000);
		expect(row!.messagesLength).toBe(3);
		expect(row!.systemTokens).toBe(1000);
		expect(row!.conversationTokens).toBe(3200);
		expect(row!.toolDefinitionsTokens).toBe(42);
	});
});
