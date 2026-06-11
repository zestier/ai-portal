import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';

const startExtractionRetryTurnMock = vi.fn();
const getTurnMock = vi.fn();

vi.mock('../src/lib/server/runtime/turn-runner', () => ({
	getTurn: (...args: unknown[]) => getTurnMock(...args),
	startExtractionRetryTurn: (...args: unknown[]) => startExtractionRetryTurnMock(...args)
}));

function fakeTurn(id = 'retry-turn') {
	return {
		id,
		conversationId: 'conv',
		startedAt: Date.now(),
		endedAt: null,
		status: 'running' as const,
		subscribe: async function* () {},
		abort: async () => {}
	};
}

async function loadPost() {
	const { POST } = await import('../src/routes/api/conversations/[id]/memory/+server');
	return POST;
}

function call(convId: string, userId: string) {
	return loadPost().then((POST) =>
		POST({
			params: { id: convId },
			locals: { userId },
			request: new Request('http://localhost/memory', { method: 'POST' })
		} as never)
	);
}

describe('memory retry-extraction endpoint', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-memory-retry-');
		startExtractionRetryTurnMock.mockReset();
		getTurnMock.mockReset();
		getTurnMock.mockReturnValue(null);
		startExtractionRetryTurnMock.mockResolvedValue(fakeTurn());
	});

	async function fixture(memoryMode: 'project' | 'off' = 'project') {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			memoryMode
		});
		return { user, conv, convs, messages };
	}

	it('defers the patch revert to the retry turn and starts an extraction-only retry', async () => {
		const { user, conv, messages } = await fixture('project');
		const memory = await import('../src/lib/server/db/repos/memory');
		const turnInputs = await import('../src/lib/server/db/repos/turn-inputs');
		const { commitPatch } = await import('../src/lib/server/memory/engine');

		const userMsg = messages.append(conv.id, { role: 'user', content: 'remember the attic key' });
		const assistantMsg = messages.append(conv.id, { role: 'assistant', content: 'noted' });
		turnInputs.record({
			messageId: userMsg.id,
			conversationId: conv.id,
			turnId: 'turn-1',
			fullInput: '',
			promptBody: '',
			prelude: ''
		});
		const committed = commitPatch({
			conversationId: conv.id,
			mode: 'project',
			turnId: 'turn-1',
			sourceMessageId: assistantMsg.id,
			patch: {
				entities: [{ entityKey: 'item.attic_key', entityType: 'item', displayName: 'Attic key' }],
				facts: [{ entityKey: 'item.attic_key', predicate: 'location', value: 'drawer' }]
			}
		});
		expect(committed.patch.status).toBe('committed');
		expect(memory.listEntities(conv.id).map((e) => e.entityKey)).toContain('item.attic_key');

		const response = await call(conv.id, user.id);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			turnId: string;
			assistantMessageId: string;
			revertPatchId: string | null;
		};
		expect(body.turnId).toBe('retry-turn');
		expect(body.assistantMessageId).toBe(assistantMsg.id);
		expect(body.revertPatchId).toBe(committed.patch.id);

		// The endpoint no longer reverts up-front: the patch is handed to the retry
		// turn, which reverts it only once re-extraction succeeds. With the turn
		// mocked here, the prior patch and its items remain intact.
		expect(memory.listEntities(conv.id).map((e) => e.entityKey)).toContain('item.attic_key');
		const patch = memory.listPatches(conv.id).find((p) => p.id === committed.patch.id);
		expect(patch?.status).toBe('committed');

		// Re-extraction reuses the stored messages, the configured turn id, and is
		// told which patch to revert on success.
		expect(startExtractionRetryTurnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: conv.id,
				userId: user.id,
				assistantMessageId: assistantMsg.id,
				assistantContent: 'noted',
				memory: expect.objectContaining({
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: 'remember the attic key',
					patchTurnId: 'turn-1',
					revertPatchId: committed.patch.id
				})
			})
		);
	});

	it('passes a null revertPatchId when the latest turn committed nothing', async () => {
		const { user, conv, messages } = await fixture('project');
		const turnInputs = await import('../src/lib/server/db/repos/turn-inputs');
		const memory = await import('../src/lib/server/db/repos/memory');

		const userMsg = messages.append(conv.id, { role: 'user', content: 'hello' });
		messages.append(conv.id, { role: 'assistant', content: 'hi' });
		turnInputs.record({
			messageId: userMsg.id,
			conversationId: conv.id,
			turnId: 'turn-1',
			fullInput: '',
			promptBody: '',
			prelude: ''
		});
		// A needs_review patch committed nothing durable.
		memory.createPatch(conv.id, { status: 'needs_review', turnId: 'turn-1' });

		const response = await call(conv.id, user.id);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { revertPatchId: string | null };
		expect(body.revertPatchId).toBeNull();
		expect(startExtractionRetryTurnMock).toHaveBeenCalledTimes(1);
		expect(startExtractionRetryTurnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				memory: expect.objectContaining({ revertPatchId: null })
			})
		);
	});

	it('returns 409 when a turn is already running', async () => {
		const { user, conv, messages } = await fixture('project');
		messages.append(conv.id, { role: 'user', content: 'q' });
		messages.append(conv.id, { role: 'assistant', content: 'a' });
		getTurnMock.mockReturnValue(fakeTurn());

		await expect(call(conv.id, user.id)).rejects.toMatchObject({ status: 409 });
		expect(startExtractionRetryTurnMock).not.toHaveBeenCalled();
	});

	it('rejects when memory is disabled', async () => {
		const { user, conv, messages } = await fixture('off');
		messages.append(conv.id, { role: 'user', content: 'q' });
		messages.append(conv.id, { role: 'assistant', content: 'a' });

		await expect(call(conv.id, user.id)).rejects.toMatchObject({ status: 400 });
		expect(startExtractionRetryTurnMock).not.toHaveBeenCalled();
	});

	it('rejects when there is no assistant turn to re-extract', async () => {
		const { user, conv, messages } = await fixture('project');
		messages.append(conv.id, { role: 'user', content: 'only a question' });

		await expect(call(conv.id, user.id)).rejects.toMatchObject({ status: 400 });
		expect(startExtractionRetryTurnMock).not.toHaveBeenCalled();
	});

	it('is authorized against the conversation owner', async () => {
		const { conv, messages } = await fixture('project');
		messages.append(conv.id, { role: 'user', content: 'q' });
		messages.append(conv.id, { role: 'assistant', content: 'a' });

		await expect(call(conv.id, 'someone-else')).rejects.toMatchObject({
			status: expect.any(Number)
		});
		expect(startExtractionRetryTurnMock).not.toHaveBeenCalled();
	});
});
