import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import { makeFakeSession } from './helpers/fake-session';

// Mock the session pool so turn-runner doesn't try to spin up the real SDK.
const acquireMock = vi.fn();
vi.mock('../src/lib/server/copilot/pool', () => ({
	acquire: (...args: unknown[]) => acquireMock(...args)
}));

async function freshImports() {
	vi.resetModules();
	await setupLocalEnv();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const turnRunner = await import('../src/lib/server/runtime/turn-runner');
	return { users, convs, turnRunner };
}

describe('turn-runner', () => {
	beforeEach(() => {
		acquireMock.mockReset();
	});

	it('marks a turn running before opening the provider session', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});
		let resolveAcquire: (session: ReturnType<typeof makeFakeSession>) => void = () => {};
		acquireMock.mockReturnValue(
			new Promise((resolve) => {
				resolveAcquire = resolve;
			})
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		expect(turnRunner.getTurn(conv.id)).toBe(turn);
		await expect(
			turnRunner.startTurn({
				bridge: {
					conversationId: conv.id,
					userId: user.id,
					workingDirectory: wd,
					model: 'gpt-4',
					policy: 'prompt'
				},
				prompt: 'second',
				conversationId: conv.id
			})
		).rejects.toThrow('turn already in progress');

		resolveAcquire(makeFakeSession([{ type: 'done' }], conv.id, wd));
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
	});

	it('replays initial conversation.update before the terminal done', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'New chat',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'Help me write a haiku about TypeScript',
			conversationId: conv.id,
			initialEvents: [
				{
					type: 'conversation.update',
					conversationId: conv.id,
					title: 'Help me write a haiku'
				}
			]
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		// Exactly one terminal `done`, and it must come last.
		const doneIndices = received.map((e, i) => (e.type === 'done' ? i : -1)).filter((i) => i >= 0);
		expect(doneIndices).toEqual([received.length - 1]);

		// The initial conversation.update must arrive before `done`.
		const updateIdx = received.findIndex((e) => e.type === 'conversation.update');
		expect(updateIdx).toBeGreaterThanOrEqual(0);
		expect(updateIdx).toBeLessThan(received.length - 1);
		const update = received[updateIdx];
		if (update.type !== 'conversation.update') throw new Error('unreachable');
		expect(update.conversationId).toBe(conv.id);
		expect(update.title).toBe('Help me write a haiku');
		expect(convs.get(conv.id, user.id)?.title).toBe('New chat');
	});

	it('does not emit conversation.update when the title is already set', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'hi' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'Anything goes here',
			conversationId: conv.id
		});

		const received: PortalEvent[] = [];
		for await (const { event } of turn.subscribe()) {
			received.push(event);
			if (event.type === 'done') break;
		}

		expect(received.find((e) => e.type === 'conversation.update')).toBeUndefined();
		expect(convs.get(conv.id, user.id)?.title).toBe('Custom title');
	});

	it('captures the full provider input when a userMessageId is provided', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const turnInputs = await import('../src/lib/server/db/repos/turn-inputs');
		const messages = await import('../src/lib/server/db/repos/messages');
		const { PORTAL_PRELUDE } = await import('../src/lib/server/copilot/portal-prelude');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'Custom title', workdir: wd, model: 'gpt-4' });

		const userMsg = messages.append(conv.id, { role: 'user', content: 'Help me' });

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'ok' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				provider: 'copilot',
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt',
				mode: 'interactive'
			},
			prompt: 'Help me',
			conversationId: conv.id,
			userMessageId: userMsg.id
		});

		// Input is recorded synchronously at start, before the turn drains.
		const recorded = turnInputs.get(conv.id, userMsg.id);
		expect(recorded).not.toBeNull();
		expect(recorded?.promptBody).toBe('Help me');
		expect(recorded?.prelude).toBe(PORTAL_PRELUDE);
		expect(recorded?.fullInput).toBe(`${PORTAL_PRELUDE}\n\nHelp me`);
		expect(recorded?.provider).toBe('copilot');
		expect(recorded?.model).toBe('gpt-4');
		expect(recorded?.mode).toBe('interactive');
		expect(recorded?.turnId).toBe(turn.id);

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
	});

	it('does not capture input when no userMessageId is provided', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const turnInputs = await import('../src/lib/server/db/repos/turn-inputs');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'Custom title', workdir: wd, model: 'gpt-4' });

		acquireMock.mockResolvedValue(makeFakeSession([{ type: 'done' }]));

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		// Nothing keyed to a user message means nothing to inspect; the table
		// simply has no row for any id we'd look up.
		expect(turnInputs.get(conv.id, 'nonexistent')).toBeNull();
	});

	it('assigns monotonic ids and replays from Last-Event-ID via sinceId', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'Custom title',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.delta', messageId: 'm1', text: 'a' },
				{ type: 'message.delta', messageId: 'm1', text: 'b' },
				{ type: 'message.delta', messageId: 'm1', text: 'c' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		// Drain the full transcript; ids must be 0..N-1 contiguous.
		const all: { id: number; event: PortalEvent }[] = [];
		for await (const item of turn.subscribe()) {
			all.push(item);
			if (item.event.type === 'done') break;
		}
		expect(all.length).toBeGreaterThan(0);
		expect(all.map((x) => x.id)).toEqual(all.map((_, i) => i));
		expect(all[all.length - 1].event.type).toBe('done');

		// Re-subscribe with `sinceId` = id of the second delta. We should
		// receive everything strictly after that id, and only that.
		const secondDeltaId = all.findIndex(
			(x) => x.event.type === 'message.delta' && x.event.text === 'b'
		);
		expect(secondDeltaId).toBeGreaterThan(0);

		const replayed: { id: number; event: PortalEvent }[] = [];
		for await (const item of turn.subscribe({ sinceId: secondDeltaId })) {
			replayed.push(item);
			if (item.event.type === 'done') break;
		}
		expect(replayed[0].id).toBe(secondDeltaId + 1);
		expect(replayed.map((x) => x.id)).toEqual(all.slice(secondDeltaId + 1).map((x) => x.id));
	});

	it('emits persisted assistant message ids for streamed assistant events', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'stable ids',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'provider-message-id', role: 'assistant' },
				{ type: 'message.delta', messageId: 'provider-message-id', text: 'hi' },
				{
					type: 'message.reasoning',
					messageId: 'provider-message-id',
					segmentId: 'r1',
					text: 'think'
				},
				{
					type: 'message.reasoning.end',
					messageId: 'provider-message-id',
					segmentId: 'r1',
					durationMs: 10
				},
				{ type: 'message.end', messageId: 'provider-message-id' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
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

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant).toBeTruthy();
		const assistantEvents = received.filter((event) => event.type.startsWith('message.'));
		expect(assistantEvents.length).toBeGreaterThan(0);
		for (const event of assistantEvents) {
			if ('messageId' in event) expect(event.messageId).toBe(assistant?.id);
		}
		expect(assistant?.id).not.toBe('provider-message-id');
	});

	it('can subscribe only to live future events after persisted state is rendered', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'skip replay',
			workdir: wd,
			model: 'gpt-4'
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			workingDirectory: wd,
			async *send(): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				yield { type: 'message.delta', messageId: 'm1', text: 'a' };
				await gate;
				yield { type: 'message.delta', messageId: 'm1', text: 'b' };
				yield { type: 'done' };
			},
			async abort() {},
			async dispose() {},
			async setMode() {},
			async setApproveAll() {},
			async resetSessionApprovals() {},
			lastUsed: Date.now()
		});

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'message.delta' && event.text === 'a') break;
		}

		const futureEventsPromise = (async () => {
			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe({ skipReplay: true })) {
				events.push(event);
				if (event.type === 'done') break;
			}
			return events;
		})();

		release();
		const futureEvents = await futureEventsPromise;
		expect(futureEvents.map((event) => event.type)).toEqual(['message.delta', 'done']);
		expect(futureEvents[0]).toMatchObject({ type: 'message.delta', text: 'b' });
	});

	it('getTurnById returns null when the turn id does not match', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 't',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(makeFakeSession([{ type: 'done' }]));

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		expect(turnRunner.getTurnById(conv.id, turn.id)).toBeTruthy();
		expect(turnRunner.getTurnById(conv.id, 'nonexistent')).toBeNull();
		expect(turnRunner.getTurnById('other-conversation', turn.id)).toBeNull();
	});

	it('persists interleaved reasoning segments anchored to their text offsets', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'reasoning',
			workdir: wd,
			model: 'gpt-4'
		});

		// Two reasoning bursts: one before any visible text, one after the
		// first chunk of text. The bridge would emit message.reasoning.end
		// when the segment transitions to non-reasoning, so we mirror that
		// here.
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's1', text: 'plan ' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's1', text: 'first' },
				{ type: 'message.reasoning.end', messageId: 'm1', segmentId: 's1', durationMs: 100 },
				{ type: 'message.delta', messageId: 'm1', text: 'hello' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's2', text: 'second ' },
				{ type: 'message.reasoning', messageId: 'm1', segmentId: 's2', text: 'thought' },
				{ type: 'message.reasoning.end', messageId: 'm1', segmentId: 's2', durationMs: 200 },
				{ type: 'message.delta', messageId: 'm1', text: ' world' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const persisted = messages.listByConversation(conv.id);
		const assistant = persisted.find((m) => m.role === 'assistant');
		expect(assistant?.content).toBe('hello world');
		const blocks = assistant?.reasoningBlocks ?? [];
		expect(blocks.length).toBe(2);
		// Segment indexes monotonic, in stream order.
		expect(blocks.map((b) => b.segmentIndex)).toEqual([0, 1]);
		// First segment opened at offset 0 (before any text); second opened
		// after "hello" was already buffered.
		expect(blocks[0].textOffset).toBe(0);
		expect(blocks[0].text).toBe('plan first');
		expect(blocks[0].durationMs).toBe(100);
		expect(blocks[1].textOffset).toBe('hello'.length);
		expect(blocks[1].text).toBe('second thought');
		expect(blocks[1].durationMs).toBe(200);
	});

	it('persists assistant content and tool calls before the turn completes', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'incremental',
			workdir: wd,
			model: 'gpt-4'
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			workingDirectory: wd,
			async *send(): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				yield { type: 'message.delta', messageId: 'm1', text: 'partial' };
				yield {
					type: 'tool.call',
					toolCallId: 'tool-1',
					tool: 'bash',
					args: { command: 'echo hi', forcePermissionPrompt: 'because this is a test' }
				};
				await gate;
				yield {
					type: 'tool.result',
					toolCallId: 'tool-1',
					ok: true,
					summary: 'ok',
					output: 'hi\n'
				};
			},
			async abort() {},
			async dispose() {},
			async setMode() {},
			async setApproveAll() {},
			async resetSessionApprovals() {},
			lastUsed: Date.now()
		});

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'tool.call') break;
		}

		const midTurn = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(midTurn).toBeTruthy();
		expect(midTurn?.status).toBe('streaming');
		expect(midTurn?.content).toBe('partial');
		expect(midTurn?.toolCalls?.[0]).toMatchObject({
			id: 'tool-1',
			tool: 'bash',
			status: 'pending'
		});
		expect(midTurn?.toolCalls?.[0]?.argsJson).toContain('forcePermissionPrompt');

		release();
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
		const done = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(done?.status).toBe('complete');
		expect(done?.toolCalls?.[0]).toMatchObject({
			id: 'tool-1',
			status: 'ok',
			resultJson: 'hi\n'
		});
	});

	it('dedupes repeated file edit events during incremental persistence', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'file edits',
			workdir: wd,
			model: 'gpt-4'
		});
		const edit: PortalEvent = {
			type: 'file.edit',
			path: 'src/a.ts',
			diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b'
		};
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				edit,
				edit,
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.fileEdits).toHaveLength(1);
		expect(assistant?.fileEdits?.[0]).toMatchObject({ path: 'src/a.ts', diff: edit.diff });
	});

	it('persists background subagent lifecycle events during a turn', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'subagent lifecycle',
			workdir: wd,
			model: 'gpt-4'
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{
					type: 'tool.call',
					toolCallId: 'task-1',
					tool: 'task',
					args: { mode: 'background', prompt: 'do work' }
				},
				{
					type: 'tool.result',
					toolCallId: 'task-1',
					ok: true,
					summary: 'launched',
					output: { agent_id: 'agent-1', content: 'launched' }
				},
				{
					type: 'subagent.lifecycle',
					toolCallId: 'task-1',
					agentId: 'agent-1',
					status: 'running'
				},
				{
					type: 'subagent.lifecycle',
					toolCallId: 'task-1',
					agentId: 'agent-1',
					status: 'completed'
				},
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'hi',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.toolCalls?.[0]).toMatchObject({
			id: 'task-1',
			status: 'ok',
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-1',
			backgroundAgentStartedAt: expect.any(Number),
			backgroundAgentEndedAt: expect.any(Number)
		});
	});

	it('persists manual rerun tool calls as separate attempts without overwriting the original', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'rerun',
			workdir: wd,
			model: 'gpt-4'
		});
		const originalMsg = messages.append(conv.id, { role: 'assistant', content: '' });
		const args = { command: 'echo approved' };
		messages.insertToolCall(originalMsg.id, {
			id: 'tc-original',
			tool: 'bash',
			argsJson: JSON.stringify(args),
			resultJson: JSON.stringify('Permission denied'),
			status: 'denied',
			startedAt: Date.now() - 100,
			endedAt: Date.now() - 50,
			textOffset: 0,
			parentToolCallId: null
		});
		acquireMock.mockResolvedValue(
			makeFakeSession([
				{ type: 'message.start', messageId: 'm1', role: 'assistant' },
				{ type: 'tool.call', toolCallId: 'tc-rerun', tool: 'bash', args },
				{ type: 'tool.result', toolCallId: 'tc-rerun', ok: true, summary: 'ok', output: 'ok' },
				{ type: 'done' }
			])
		);

		const turn = await turnRunner.startTurn({
			bridge: {
				conversationId: conv.id,
				userId: user.id,
				workingDirectory: wd,
				model: 'gpt-4',
				policy: 'prompt'
			},
			prompt: 'rerun',
			conversationId: conv.id
		});

		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}

		const toolCalls = messages.listByConversation(conv.id).flatMap((m) => m.toolCalls ?? []);
		expect(toolCalls.find((t) => t.id === 'tc-original')).toMatchObject({
			status: 'denied'
		});
		expect(toolCalls.find((t) => t.id === 'tc-rerun')).toMatchObject({
			status: 'ok'
		});
	});
});
