import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortalEvent } from '../../../src/lib/types';
import { conversationId as convCodec } from '../../../src/lib/ids';
import { setupLocalEnv } from '../../helpers/env';
import { makeFakeSession } from '../../helpers/fake-session';

const acquireMock = vi.fn();
vi.mock('../../../src/lib/server/runtime/pool', () => ({
	acquire: (...args: unknown[]) => acquireMock(...args),
	registerKeepAlive: () => {}
}));

async function freshImports() {
	vi.resetModules();
	await setupLocalEnv();
	const users = await import('../../../src/lib/server/db/repos/users');
	const convs = await import('../../../src/lib/server/db/repos/conversations');
	const usage = await import('../../../src/lib/server/db/repos/usage');
	const turnRunner = await import('../../../src/lib/server/runtime/turn-runner');
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
			tokenLimit: 200_000
		});
		const a = usage.get(conv.id);
		expect(a).not.toBeNull();
		expect(a!.currentTokens).toBe(1200);
		expect(a!.tokenLimit).toBe(200_000);

		// Upsert overwrites.
		usage.upsert(conv.id, {
			currentTokens: 1500,
			tokenLimit: 200_000
		});
		const b = usage.get(conv.id);
		expect(b!.currentTokens).toBe(1500);
		expect(b!.tokenLimit).toBe(200_000);
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
				{ type: 'message.start', messageId: 'M1', role: 'assistant' },
				{
					type: 'context.usage',
					currentTokens: 4242,
					tokenLimit: 128_000,
					percentage: 3.3,
					isInitial: false
				},
				{ type: 'message.delta', messageId: 'M1', text: 'hello' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: convCodec.parse(conv.id),
				userId: user.id,
				workingDirectory: '/tmp',
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: convCodec.parse(conv.id)
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
	});
});
