import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import { makeFakeSession } from './helpers/fake-session';

// Mock the session pool so turn-runner doesn't try to spin up the real SDK.
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

	it('reserveTurn throws a typed TurnAlreadyInProgressError on a second reservation', async () => {
		const { turnRunner } = await freshImports();
		const id = 'conv-reserve';

		turnRunner.reserveTurn(id);
		try {
			expect(() => turnRunner.reserveTurn(id)).toThrow(turnRunner.TurnAlreadyInProgressError);
			const err = (() => {
				try {
					turnRunner.reserveTurn(id);
				} catch (e) {
					return e;
				}
			})() as InstanceType<typeof turnRunner.TurnAlreadyInProgressError>;
			expect(err.conversationId).toBe(id);
		} finally {
			turnRunner.releaseTurnReservation(id);
		}

		// After release the slot is free again.
		expect(() => turnRunner.reserveTurn(id)).not.toThrow();
		turnRunner.releaseTurnReservation(id);
	});

	it('startTurn throws a typed TurnAlreadyInProgressError when a turn is running', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'c', workdir: wd, model: 'gpt-4' });

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
		).rejects.toBeInstanceOf(turnRunner.TurnAlreadyInProgressError);

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
		const { PORTAL_PRELUDE } = await import('../src/lib/server/runtime/portal-prelude');
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

	it('tags the terminal done with status complete on a clean finish', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'clean', workdir: wd, model: 'gpt-4' });

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
			prompt: 'hi',
			conversationId: conv.id
		});

		let done: PortalEvent | undefined;
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') {
				done = event;
				break;
			}
		}
		expect(done).toMatchObject({ type: 'done', status: 'complete' });
	});

	it('tags the terminal done with status interrupted when the turn is aborted', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'aborted', workdir: wd, model: 'gpt-4' });

		// A session whose stream stays open until the turn's abort signal fires,
		// then returns — exercising the server-side interrupt path that emits a
		// bare terminal `done` (no preceding `error`).
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			providerSessionId: conv.id,
			workingDirectory: wd,
			model: 'test-model',
			async *send(_prompt: string, signal?: AbortSignal): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener('abort', () => resolve(), { once: true });
				});
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
			if (event.type === 'message.start') {
				void turn.abort();
				break;
			}
		}

		let done: PortalEvent | undefined;
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') {
				done = event;
				break;
			}
		}
		expect(done).toMatchObject({ type: 'done', status: 'interrupted' });
	});

	it('persists a failed stream as error and tags the terminal done with status error', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const messages = await import('../src/lib/server/db/repos/messages');
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'boom', workdir: wd, model: 'gpt-4' });

		// A session that streams a partial reply then throws a non-abort error
		// (provider crash / network drop / rate-limit) without the user issuing
		// Stop — the case that previously finalized as a false 'complete'.
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			providerSessionId: conv.id,
			workingDirectory: wd,
			model: 'test-model',
			async *send(): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				yield { type: 'message.delta', messageId: 'm1', text: 'partial' };
				throw new Error('provider exploded');
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

		const seen: PortalEvent[] = [];
		let done: PortalEvent | undefined;
		for await (const { event } of turn.subscribe()) {
			seen.push(event);
			if (event.type === 'done') {
				done = event;
				break;
			}
		}

		// The transient error event is still surfaced into the live stream...
		expect(seen.some((e) => e.type === 'error' && e.code === 'stream_failed')).toBe(true);
		// ...and the terminal done now carries the failure, not a false 'complete'.
		expect(done).toMatchObject({ type: 'done', status: 'error' });
		// The turn itself ends in the previously-dead 'error' state.
		expect(turnRunner.getTurn(conv.id)?.status).toBe('error');

		// The persisted assistant message reflects the failure (status + error_code),
		// so history/export filters keyed on status='complete' won't silently
		// include this failed turn.
		const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
		expect(assistant?.status).toBe('error');
		expect(assistant?.errorCode).toBe('stream_failed');
		expect(assistant?.content).toBe('partial');
	});

	it('force-disposes the session when abort() hangs past the finalize deadline', async () => {
		process.env.TURN_ABORT_FINALIZE_DEADLINE_MS = '50';
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, { title: 'wedged abort', workdir: wd, model: 'gpt-4' });

		let disposed = false;
		let resolveDisposed: () => void = () => {};
		const disposedCalled = new Promise<void>((resolve) => {
			resolveDisposed = resolve;
		});

		// A session whose abort() never settles (subprocess wedged in I/O). The
		// turn must still escalate to dispose() to avoid orphaning the session.
		acquireMock.mockResolvedValue({
			conversationId: conv.id,
			providerSessionId: conv.id,
			workingDirectory: wd,
			model: 'test-model',
			async *send(_prompt: string, signal?: AbortSignal): AsyncIterable<PortalEvent> {
				yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener('abort', () => resolve(), { once: true });
				});
			},
			abort() {
				// Never resolves: simulate a wedged SDK subprocess.
				return new Promise<void>(() => {});
			},
			async dispose() {
				disposed = true;
				resolveDisposed();
			},
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
			if (event.type === 'message.start') {
				void turn.abort();
				break;
			}
		}

		let done: PortalEvent | undefined;
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') {
				done = event;
				break;
			}
		}
		// The turn finalizes regardless of the wedged abort()...
		expect(done).toMatchObject({ type: 'done', status: 'interrupted' });
		// ...and the hung abort() is escalated to a force-dispose so the wedged
		// subprocess isn't orphaned.
		await disposedCalled;
		expect(disposed).toBe(true);

		delete process.env.TURN_ABORT_FINALIZE_DEADLINE_MS;
	});

	it('force-disposes the session when the early-abort path hits a wedged abort()', async () => {
		// The turn is aborted while `pool.acquire` is still pending, so the abort
		// is observed immediately after acquire resolves (the early-abort branch)
		// rather than mid-stream. A bare `await session.abort()` there would hang
		// `finishedPromise` (and turn cleanup) forever on a wedged subprocess; the
		// deadline helper must still escalate to a force-dispose.
		process.env.TURN_ABORT_FINALIZE_DEADLINE_MS = '50';
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'early wedged abort',
			workdir: wd,
			model: 'gpt-4'
		});

		let disposed = false;
		let resolveDisposed: () => void = () => {};
		const disposedCalled = new Promise<void>((resolve) => {
			resolveDisposed = resolve;
		});

		// Hold acquire pending so we can abort the turn before the session exists,
		// then resolve with a session whose abort() never settles.
		let resolveAcquire: (session: unknown) => void = () => {};
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

		// Abort while acquire is still pending: session is null here, so the
		// early-abort branch (not turn.abort) owns the wedged teardown.
		void turn.abort();

		resolveAcquire({
			conversationId: conv.id,
			providerSessionId: conv.id,
			workingDirectory: wd,
			model: 'test-model',
			// eslint-disable-next-line require-yield -- must never be called on this path
			async *send(): AsyncIterable<PortalEvent> {
				// Should never run: the turn is already aborted on acquire.
				throw new Error('send must not be called on the early-abort path');
			},
			abort() {
				return new Promise<void>(() => {});
			},
			async dispose() {
				disposed = true;
				resolveDisposed();
			},
			async setMode() {},
			async setApproveAll() {},
			async resetSessionApprovals() {},
			lastUsed: Date.now()
		});

		let done: PortalEvent | undefined;
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') {
				done = event;
				break;
			}
		}
		// The turn finalizes as interrupted despite the wedged abort()...
		expect(done).toMatchObject({ type: 'done', status: 'interrupted' });
		// ...and the hung abort() escalates to a force-dispose.
		await disposedCalled;
		expect(disposed).toBe(true);

		delete process.env.TURN_ABORT_FINALIZE_DEADLINE_MS;
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

	it('delivers a terminal done when subscribing with skipReplay after the turn finished', async () => {
		const { users, convs, turnRunner } = await freshImports();
		const user = users.ensureLocalUser();
		const wd = makeTmpDir('portal-wd-');
		const conv = convs.create(user.id, {
			title: 'skip replay finished',
			workdir: wd,
			model: 'gpt-4'
		});

		acquireMock.mockResolvedValue(
			makeFakeSession(
				[
					{ type: 'message.start', messageId: 'm1', role: 'assistant' },
					{ type: 'message.delta', messageId: 'm1', text: 'hi' },
					{ type: 'done' }
				],
				conv.id,
				wd
			)
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

		// Drain the turn to completion so it is no longer running.
		for await (const { event } of turn.subscribe()) {
			if (event.type === 'done') break;
		}
		expect(turn.status).not.toBe('running');

		// Attaching with skipReplay in this window must still yield a terminal
		// `done` rather than completing with silence.
		const events: PortalEvent[] = [];
		for await (const { event } of turn.subscribe({ skipReplay: true })) {
			events.push(event);
			if (event.type === 'done') break;
		}
		expect(events.map((e) => e.type)).toEqual(['done']);
		expect(events[events.length - 1]).toMatchObject({ type: 'done' });
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

	it('surfaces tool-calling memory extraction as a persisted subagent card', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		// SSE chunk streams (the extractor requests stream: true). First step
		// streams reasoning + a staging tool call; second step streams the
		// closing message with no tool calls.
		const sseChunks = [
			[
				{
					choices: [
						{ delta: { reasoning: 'The user chose append-only migrations; store that decision.' } }
					]
				},
				{ choices: [{ delta: { content: 'Recording the decision now.' } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call-1',
										function: {
											name: 'memory_set_attributes',
											arguments: JSON.stringify({
												entityKey: 'migrations',
												attributes: [
													{ predicate: 'decision', value: 'Use append-only migrations.' }
												]
											})
										}
									}
								]
							}
						}
					]
				}
			],
			[{ choices: [{ delta: { content: 'Stored the migration decision.' } }] }]
		];
		let chatCall = 0;
		const fetchMock = vi.fn(async () => {
			const chunks = sseChunks[Math.min(chatCall, sseChunks.length - 1)];
			chatCall += 1;
			const text =
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(text, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const { users, convs, turnRunner } = await freshImports();
			const messages = await import('../src/lib/server/db/repos/messages');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem card', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, {
				role: 'user',
				content: 'Remember we chose append-only migrations.'
			});

			acquireMock.mockResolvedValue(
				makeFakeSession([
					{ type: 'message.start', messageId: 'm1', role: 'assistant' },
					{ type: 'message.delta', messageId: 'm1', text: 'Done.' },
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
				conversationId: conv.id,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: 'Remember we chose append-only migrations.'
				}
			});

			for await (const { event } of turn.subscribe()) {
				if (event.type === 'done') break;
			}

			const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
			// The extractor surfaces as a normal `task` subagent; only its
			// agent_type arg marks it as the memory extractor.
			const parent = assistant?.toolCalls?.find((t) => {
				if (t.tool !== 'task') return false;
				try {
					return JSON.parse(t.argsJson).agent_type === 'memory-extractor';
				} catch {
					return false;
				}
			});
			expect(parent).toBeTruthy();
			expect(parent?.status).toBe('ok');
			// The extractor's input context is threaded onto the card as a
			// `prompt`, mirroring a real subagent, so the UI can show what the
			// background agent was asked to work from.
			const parentArgs = JSON.parse(parent?.argsJson ?? '{}');
			expect(typeof parentArgs.prompt).toBe('string');
			expect(parentArgs.prompt.length).toBeGreaterThan(0);
			expect(parentArgs.prompt).toContain('append-only migrations');
			// Subagent lifecycle events flowed and persisted, exactly like a real
			// subagent (running -> completed, with an agent id + timing).
			expect(parent?.backgroundAgentStatus).toBe('completed');
			expect(parent?.backgroundAgentId).toBeTruthy();
			const child = assistant?.toolCalls?.find(
				(t) => t.parentToolCallId === parent?.id && t.tool === 'memory_set_attributes'
			);
			expect(child).toBeTruthy();
			expect(child?.status).toBe('ok');
			// The extractor's thoughts are persisted as a child reasoning block
			// threaded under the parent card, so the background session reads
			// like a real sub-session.
			const childReasoning = (assistant?.reasoningBlocks ?? []).filter(
				(r) => r.parentToolCallId === parent?.id
			);
			expect(childReasoning.length).toBeGreaterThan(0);
			expect(childReasoning.map((r) => r.text).join('\n')).toContain('append-only migrations');
			// The model's closing message is surfaced as the card's response.
			expect(child?.parentToolCallId).toBe(parent?.id);
			expect(parent?.resultJson ?? '').toContain('Stored the migration decision.');
		} finally {
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			vi.unstubAllGlobals();
		}
	});

	describe('post-extraction main-model priming', () => {
		// A warmup prime request is the one with `max_tokens: 1` and `stream:
		// false`; the model-backed extractor uses streaming requests, so we can
		// tell the two apart at the fetch layer.
		function isPrimeBody(body: unknown): boolean {
			return (
				typeof body === 'object' &&
				body !== null &&
				(body as { max_tokens?: unknown }).max_tokens === 1 &&
				(body as { stream?: unknown }).stream === false
			);
		}

		// Fetch stub that records prime warmup requests and answers everything
		// else (the model-backed extractor's streaming call) with an empty,
		// commit-nothing SSE turn. `onPrime` can override the prime response
		// (e.g. to hang) — it defaults to a trivial 200.
		function makeExtractorFetch(opts: {
			primeBodies: unknown[];
			onPrime?: () => Promise<Response>;
		}) {
			return vi.fn(async (_url: unknown, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				if (isPrimeBody(body)) {
					opts.primeBodies.push(body);
					return opts.onPrime
						? opts.onPrime()
						: Response.json({ choices: [{ message: { content: '' } }] });
				}
				return new Response(
					'data: {"choices":[{"delta":{"content":"noop"}}]}\n\ndata: [DONE]\n\n',
					{
						status: 200,
						headers: { 'content-type': 'text/event-stream' }
					}
				);
			});
		}

		async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate()) return true;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return predicate();
		}

		async function runMemoryTurn(bridgeOverrides: {
			provider?: string | undefined;
			model: string;
		}): Promise<{ primeBodies: unknown[] }> {
			const { users, convs, turnRunner } = await freshImports();
			const messagesRepo = await import('../src/lib/server/db/repos/messages');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, {
				title: 'prime',
				workdir: wd,
				model: bridgeOverrides.model
			});
			const userMsg = messagesRepo.append(conv.id, { role: 'user', content: 'remember this' });

			acquireMock.mockResolvedValue(
				makeFakeSession([
					{ type: 'message.start', messageId: 'm1', role: 'assistant' },
					{ type: 'message.delta', messageId: 'm1', text: 'Done.' },
					{ type: 'done' }
				])
			);

			const primeBodies: unknown[] = [];
			vi.stubGlobal('fetch', makeExtractorFetch({ primeBodies }));

			const turn = await turnRunner.startTurn({
				bridge: {
					conversationId: conv.id,
					userId: user.id,
					workingDirectory: wd,
					model: bridgeOverrides.model,
					policy: 'prompt',
					...(bridgeOverrides.provider !== undefined
						? { provider: bridgeOverrides.provider as never }
						: {})
				},
				prompt: 'hi',
				conversationId: conv.id,
				memory: { mode: 'project', userMessageId: userMsg.id, userContent: 'remember this' }
			});
			for await (const { event } of turn.subscribe()) {
				if (event.type === 'done') break;
			}
			return { primeBodies };
		}

		function setModelBackedExtractorEnv() {
			process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
			process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
			process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		}

		function clearExtractorEnv() {
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			delete process.env.MEMORY_PRIME_MAIN_MODEL;
			vi.unstubAllGlobals();
		}

		it('primes the main model after extraction on a local backend when the extractor model differs', async () => {
			setModelBackedExtractorEnv();
			try {
				const { primeBodies } = await runMemoryTurn({
					provider: 'openai-compatible',
					model: 'main-model'
				});
				expect(await waitFor(() => primeBodies.length > 0)).toBe(true);
				expect(primeBodies[0]).toMatchObject({ model: 'main-model', max_tokens: 1, stream: false });
			} finally {
				clearExtractorEnv();
			}
		});

		it('does not prime when the provider is Copilot (no local cold-load concept)', async () => {
			setModelBackedExtractorEnv();
			try {
				// provider undefined resolves to copilot, whose capability flag is false.
				const { primeBodies } = await runMemoryTurn({ provider: undefined, model: 'main-model' });
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(primeBodies).toHaveLength(0);
			} finally {
				clearExtractorEnv();
			}
		});

		it('does not prime when the extractor model equals the main model', async () => {
			setModelBackedExtractorEnv();
			try {
				const { primeBodies } = await runMemoryTurn({
					provider: 'openai-compatible',
					model: 'tool-extractor'
				});
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(primeBodies).toHaveLength(0);
			} finally {
				clearExtractorEnv();
			}
		});

		it('does not prime when the extractor is heuristic (no model loaded, no eviction)', async () => {
			process.env.MEMORY_EXTRACTOR_BACKEND = 'heuristic';
			try {
				const { primeBodies } = await runMemoryTurn({
					provider: 'openai-compatible',
					model: 'main-model'
				});
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(primeBodies).toHaveLength(0);
			} finally {
				clearExtractorEnv();
			}
		});

		it('does not prime when the MEMORY_PRIME_MAIN_MODEL kill switch is off', async () => {
			setModelBackedExtractorEnv();
			process.env.MEMORY_PRIME_MAIN_MODEL = '0';
			try {
				const { primeBodies } = await runMemoryTurn({
					provider: 'openai-compatible',
					model: 'main-model'
				});
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(primeBodies).toHaveLength(0);
			} finally {
				clearExtractorEnv();
			}
		});

		it('never lets a hanging prime affect the turn: done still fires on time', async () => {
			setModelBackedExtractorEnv();
			try {
				const { users, convs, turnRunner } = await freshImports();
				const messagesRepo = await import('../src/lib/server/db/repos/messages');
				const user = users.ensureLocalUser();
				const wd = makeTmpDir('portal-wd-');
				const conv = convs.create(user.id, {
					title: 'prime-hang',
					workdir: wd,
					model: 'main-model'
				});
				const userMsg = messagesRepo.append(conv.id, { role: 'user', content: 'remember this' });

				acquireMock.mockResolvedValue(
					makeFakeSession([
						{ type: 'message.start', messageId: 'm1', role: 'assistant' },
						{ type: 'message.delta', messageId: 'm1', text: 'Done.' },
						{ type: 'done' }
					])
				);

				const primeBodies: unknown[] = [];
				// The prime request never resolves; the turn must still finish.
				vi.stubGlobal(
					'fetch',
					makeExtractorFetch({ primeBodies, onPrime: () => new Promise<Response>(() => {}) })
				);

				const turn = await turnRunner.startTurn({
					bridge: {
						conversationId: conv.id,
						userId: user.id,
						workingDirectory: wd,
						model: 'main-model',
						policy: 'prompt',
						provider: 'openai-compatible'
					},
					prompt: 'hi',
					conversationId: conv.id,
					memory: { mode: 'project', userMessageId: userMsg.id, userContent: 'remember this' }
				});

				let done: { status?: string } | null = null;
				const finished = await Promise.race([
					(async () => {
						for await (const { event } of turn.subscribe()) {
							if (event.type === 'done') {
								done = event;
								return true;
							}
						}
						return false;
					})(),
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))
				]);

				expect(finished).toBe(true);
				expect(done).toMatchObject({ status: 'complete' });
				// The prime was attempted (and is still hanging) but never blocked done.
				expect(await waitFor(() => primeBodies.length > 0)).toBe(true);
			} finally {
				clearExtractorEnv();
			}
		});
	});

	it('nudges memory-mode turns that only queried recall tools to actually answer', async () => {
		vi.resetModules();
		await setupLocalEnv();
		// Keep the post-turn extractor out of the way so the turn finalizes fast.
		vi.doMock('../src/lib/server/memory/extractor', async () => {
			const actual = await vi.importActual<typeof import('../src/lib/server/memory/extractor')>(
				'../src/lib/server/memory/extractor'
			);
			return {
				...actual,
				extractAndCommitMemory: vi.fn(async () => ({
					extraction: { response: '' },
					patch: { id: 'mem-patch', status: 'committed', summary: '' },
					counts: { events: 0 }
				}))
			};
		});
		try {
			const users = await import('../src/lib/server/db/repos/users');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const messages = await import('../src/lib/server/db/repos/messages');
			const turnRunner = await import('../src/lib/server/runtime/turn-runner');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem nudge', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, { role: 'user', content: 'where is Mara?' });

			const prompts: string[] = [];
			let sendCount = 0;
			acquireMock.mockResolvedValue({
				conversationId: conv.id,
				workingDirectory: wd,
				async *send(prompt: string): AsyncIterable<PortalEvent> {
					prompts.push(prompt);
					sendCount += 1;
					if (sendCount === 1) {
						// First turn: only a memory recall tool, no user-facing text —
						// the "checked memory then ended the turn" failure mode.
						yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
						yield {
							type: 'tool.call',
							toolCallId: 'mem-1',
							tool: 'memory_search',
							args: { query: 'Mara' }
						};
						yield {
							type: 'tool.result',
							toolCallId: 'mem-1',
							ok: true,
							summary: 'found',
							output: 'Mara is in the tower.'
						};
					} else {
						// Continuation after the nudge: now actually answer.
						yield { type: 'message.delta', messageId: 'm1', text: 'Mara is in the tower.' };
					}
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
				prompt: 'where is Mara?',
				conversationId: conv.id,
				memory: { mode: 'project', userMessageId: userMsg.id, userContent: 'where is Mara?' }
			});

			for await (const { event } of turn.subscribe()) {
				if (event.type === 'done') break;
			}

			// The guard re-sent exactly once with the continuation nudge.
			expect(sendCount).toBe(2);
			expect(prompts[1]).toContain('not yet answered');
			// The assistant ultimately produced a substantive reply.
			const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
			expect(assistant?.content).toContain('Mara is in the tower.');
			expect(assistant?.toolCalls?.[0]).toMatchObject({ id: 'mem-1', tool: 'memory_search' });
		} finally {
			vi.doUnmock('../src/lib/server/memory/extractor');
		}
	});

	it('does not nudge a memory-mode turn whose only top-level tool was a write', async () => {
		vi.resetModules();
		await setupLocalEnv();
		vi.doMock('../src/lib/server/memory/extractor', async () => {
			const actual = await vi.importActual<typeof import('../src/lib/server/memory/extractor')>(
				'../src/lib/server/memory/extractor'
			);
			return {
				...actual,
				extractAndCommitMemory: vi.fn(async () => ({
					extraction: { response: '' },
					patch: { id: 'mem-patch', status: 'committed', summary: '' },
					counts: { events: 0 }
				}))
			};
		});
		try {
			const users = await import('../src/lib/server/db/repos/users');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const messages = await import('../src/lib/server/db/repos/messages');
			const turnRunner = await import('../src/lib/server/runtime/turn-runner');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem write', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, { role: 'user', content: 'note this globally' });

			let sendCount = 0;
			acquireMock.mockResolvedValue({
				conversationId: conv.id,
				workingDirectory: wd,
				async *send(): AsyncIterable<PortalEvent> {
					sendCount += 1;
					// A write tool (memory_global_record) with no user-facing
					// text is NOT the recall-then-nothing failure mode, so the
					// guard must leave it alone.
					yield { type: 'message.start', messageId: 'm1', role: 'assistant' };
					yield {
						type: 'tool.call',
						toolCallId: 'w-1',
						tool: 'memory_global_record',
						args: { text: 'user prefers metric units' }
					};
					yield {
						type: 'tool.result',
						toolCallId: 'w-1',
						ok: true,
						summary: 'stored',
						output: 'ok'
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
				prompt: 'note this globally',
				conversationId: conv.id,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: 'note this globally'
				}
			});

			for await (const { event } of turn.subscribe()) {
				if (event.type === 'done') break;
			}

			// No continuation nudge: a write-only turn is not the targeted bug.
			expect(sendCount).toBe(1);
		} finally {
			vi.doUnmock('../src/lib/server/memory/extractor');
		}
	});

	it('frees the turn and marks memory skipped when Stop hits during extraction', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		// Short post-abort deadline; keep the absolute ceiling huge so only the
		// post-abort path can finalize this turn.
		process.env.TURN_ABORT_FINALIZE_DEADLINE_MS = '50';
		process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS = '60000';
		process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS = '60000';

		let capturedSignal: AbortSignal | undefined;
		vi.resetModules();
		await setupLocalEnv();
		// An extractor that ignores its abort signal and never resolves: only the
		// watchdog can end the turn. Emits an `input` activity so the subagent
		// card materializes (and must be closed when the extraction is abandoned).
		vi.doMock('../src/lib/server/memory/extractor', async () => {
			const actual = await vi.importActual<typeof import('../src/lib/server/memory/extractor')>(
				'../src/lib/server/memory/extractor'
			);
			return {
				...actual,
				extractAndCommitMemory: vi.fn(
					(input: {
						signal?: AbortSignal;
						onActivity?: (a: { type: string; text: string }) => void;
					}) => {
						capturedSignal = input.signal;
						input.onActivity?.({ type: 'input', text: 'extractor context' });
						return new Promise(() => {});
					}
				)
			};
		});
		try {
			const users = await import('../src/lib/server/db/repos/users');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const messages = await import('../src/lib/server/db/repos/messages');
			const turnRunner = await import('../src/lib/server/runtime/turn-runner');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem stop', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, { role: 'user', content: 'remember this' });

			acquireMock.mockResolvedValue(
				makeFakeSession([
					{ type: 'message.start', messageId: 'm1', role: 'assistant' },
					{ type: 'message.delta', messageId: 'm1', text: 'Done.' },
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
				conversationId: conv.id,
				memory: { mode: 'project', userMessageId: userMsg.id, userContent: 'remember this' }
			});

			// Wait until extraction has started (its card is live), then Stop.
			for await (const { event } of turn.subscribe()) {
				if (event.type === 'memory.status' && event.phase === 'extracting') {
					void turn.abort();
					break;
				}
			}

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}

			// The turn reached a terminal `interrupted` done despite the extractor
			// never unwinding on its own.
			expect(events.find((e) => e.type === 'done')).toMatchObject({
				type: 'done',
				status: 'interrupted'
			});
			// Memory surfaced as cancelled/skipped.
			expect(events.find((e) => e.type === 'memory.status' && e.phase === 'skipped')).toBeTruthy();
			// The extraction signal was aborted, so no partial patch can commit.
			expect(capturedSignal?.aborted).toBe(true);
			// Assistant reply retained.
			const assistant = messages.listByConversation(conv.id).find((m) => m.role === 'assistant');
			expect(assistant?.content).toContain('Done.');
			// The spinning subagent card was closed (not left running).
			const parent = assistant?.toolCalls?.find((t) => {
				try {
					return JSON.parse(t.argsJson).agent_type === 'memory-extractor';
				} catch {
					return false;
				}
			});
			expect(parent?.backgroundAgentStatus).toBe('failed');
			// Turn freed: it is no longer `running`, so a fresh send is accepted.
			expect(turnRunner.getTurn(conv.id)?.status).not.toBe('running');
		} finally {
			vi.doUnmock('../src/lib/server/memory/extractor');
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			delete process.env.TURN_ABORT_FINALIZE_DEADLINE_MS;
			delete process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS;
			delete process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS;
		}
	});

	it('finalizes via the watchdog ceiling when extraction ignores abort and overruns', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		// No user Stop in this case: only the absolute extraction-phase ceiling
		// can free the turn, so keep it small.
		process.env.TURN_ABORT_FINALIZE_DEADLINE_MS = '5000';
		process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS = '40';
		process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS = '40';

		let capturedSignal: AbortSignal | undefined;
		vi.resetModules();
		await setupLocalEnv();
		vi.doMock('../src/lib/server/memory/extractor', async () => {
			const actual = await vi.importActual<typeof import('../src/lib/server/memory/extractor')>(
				'../src/lib/server/memory/extractor'
			);
			return {
				...actual,
				extractAndCommitMemory: vi.fn((input: { signal?: AbortSignal }) => {
					capturedSignal = input.signal;
					// Never resolves and never observes the abort signal.
					return new Promise(() => {});
				})
			};
		});
		try {
			const users = await import('../src/lib/server/db/repos/users');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const messages = await import('../src/lib/server/db/repos/messages');
			const turnRunner = await import('../src/lib/server/runtime/turn-runner');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem ceiling', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, { role: 'user', content: 'remember this' });

			acquireMock.mockResolvedValue(
				makeFakeSession([
					{ type: 'message.start', messageId: 'm1', role: 'assistant' },
					{ type: 'message.delta', messageId: 'm1', text: 'Done.' },
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
				conversationId: conv.id,
				memory: { mode: 'project', userMessageId: userMsg.id, userContent: 'remember this' }
			});

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}

			// The turn finalized cleanly (no user Stop) once the extraction-phase
			// ceiling tripped, surfacing the extraction for review.
			expect(events.find((e) => e.type === 'done')).toMatchObject({
				type: 'done',
				status: 'complete'
			});
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'needs_review')
			).toBeTruthy();
			// The watchdog aborted the extractor, so its commit path is fenced off.
			expect(capturedSignal?.aborted).toBe(true);
			expect(turnRunner.getTurn(conv.id)?.status).not.toBe('running');
		} finally {
			vi.doUnmock('../src/lib/server/memory/extractor');
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			delete process.env.TURN_ABORT_FINALIZE_DEADLINE_MS;
			delete process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS;
			delete process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS;
		}
	});

	it('re-runs extraction for an existing assistant message via startExtractionRetryTurn', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		const sseChunks = [
			[
				{ choices: [{ delta: { reasoning: 'Re-extracting the migration decision.' } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call-1',
										function: {
											name: 'memory_set_attributes',
											arguments: JSON.stringify({
												entityKey: 'migrations',
												attributes: [
													{ predicate: 'decision', value: 'Use append-only migrations.' }
												]
											})
										}
									}
								]
							}
						}
					]
				}
			],
			[{ choices: [{ delta: { content: 'Stored the migration decision.' } }] }]
		];
		let chatCall = 0;
		const fetchMock = vi.fn(async () => {
			const chunks = sseChunks[Math.min(chatCall, sseChunks.length - 1)];
			chatCall += 1;
			const text =
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(text, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const { users, convs, turnRunner } = await freshImports();
			const messages = await import('../src/lib/server/db/repos/messages');
			const memory = await import('../src/lib/server/db/repos/memory');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, { title: 'mem retry', workdir: wd, model: 'gpt-4' });
			const userMsg = messages.append(conv.id, {
				role: 'user',
				content: 'Remember we chose append-only migrations.'
			});
			const assistantMsg = messages.append(conv.id, { role: 'assistant', content: 'Done.' });

			const turn = await turnRunner.startExtractionRetryTurn({
				conversationId: conv.id,
				userId: user.id,
				assistantMessageId: assistantMsg.id,
				assistantContent: assistantMsg.content,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					patchTurnId: 'turn-1'
				}
			});

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}

			// Live status lifecycle flowed: extracting -> validating -> committed.
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'extracting')
			).toBeTruthy();
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'committed')
			).toBeTruthy();
			expect(events.find((e) => e.type === 'done')).toMatchObject({
				type: 'done',
				status: 'complete'
			});

			// The extractor card is persisted onto the SAME existing assistant
			// message; no new assistant message was appended.
			const assistants = messages.listByConversation(conv.id).filter((m) => m.role === 'assistant');
			expect(assistants).toHaveLength(1);
			expect(assistants[0].id).toBe(assistantMsg.id);
			expect(assistants[0].content).toBe('Done.');
			const parent = assistants[0].toolCalls?.find((t) => {
				try {
					return JSON.parse(t.argsJson).agent_type === 'memory-extractor';
				} catch {
					return false;
				}
			});
			expect(parent).toBeTruthy();
			expect(parent?.backgroundAgentStatus).toBe('completed');

			// The patch committed under the stable turn id so the undo can find it.
			const patch = memory.listPatches(conv.id).find((p) => p.status === 'committed');
			expect(patch?.turnId).toBe('turn-1');
			expect(memory.listFacts(conv.id).map((f) => f.value)).toContain(
				'Use append-only migrations.'
			);

			// Turn freed.
			expect(turnRunner.getTurn(conv.id)?.status).not.toBe('running');
		} finally {
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			vi.unstubAllGlobals();
		}
	});

	it('undoes the prior committed patch only after a successful re-extraction', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		const sseChunks = [
			[
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call-1',
										function: {
											name: 'memory_set_attributes',
											arguments: JSON.stringify({
												entityKey: 'migrations',
												attributes: [
													{ predicate: 'decision', value: 'Use append-only migrations.' }
												]
											})
										}
									}
								]
							}
						}
					]
				}
			],
			[{ choices: [{ delta: { content: 'Stored the migration decision.' } }] }]
		];
		let chatCall = 0;
		const fetchMock = vi.fn(async () => {
			const chunks = sseChunks[Math.min(chatCall, sseChunks.length - 1)];
			chatCall += 1;
			const text =
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(text, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const { users, convs, turnRunner } = await freshImports();
			const messages = await import('../src/lib/server/db/repos/messages');
			const memory = await import('../src/lib/server/db/repos/memory');
			const { commitPatch } = await import('../src/lib/server/memory/engine');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, {
				title: 'mem retry revert',
				workdir: wd,
				model: 'gpt-4'
			});
			const userMsg = messages.append(conv.id, {
				role: 'user',
				content: 'Remember we chose append-only migrations.'
			});
			const assistantMsg = messages.append(conv.id, { role: 'assistant', content: 'Done.' });

			// A prior committed patch for the same logical turn.
			const prior = commitPatch({
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-1',
				sourceMessageId: assistantMsg.id,
				patch: {
					entities: [{ entityKey: 'migrations', entityType: 'topic', displayName: 'Migrations' }],
					facts: [{ entityKey: 'migrations', predicate: 'decision', value: 'Stale decision.' }]
				}
			});
			expect(prior.patch.status).toBe('committed');
			expect(memory.listFacts(conv.id).map((f) => f.value)).toContain('Stale decision.');

			const turn = await turnRunner.startExtractionRetryTurn({
				conversationId: conv.id,
				userId: user.id,
				assistantMessageId: assistantMsg.id,
				assistantContent: assistantMsg.content,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					patchTurnId: 'turn-1',
					priorPatchId: prior.patch.id
				}
			});

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'committed')
			).toBeTruthy();

			// The prior patch's contributions were undone as part of the successful
			// retry and the replacement landed: the stale fact is gone, the fresh
			// one is present. Only the active set is re-derived — the prior patch
			// row itself is left untouched (no 'reverted' status).
			const facts = memory.listFacts(conv.id).map((f) => f.value);
			expect(facts).toContain('Use append-only migrations.');
			expect(facts).not.toContain('Stale decision.');
		} finally {
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			vi.unstubAllGlobals();
		}
	});

	it('feeds the re-extractor memory as of turn start, not its own prior committed output', async () => {
		process.env.MEMORY_EXTRACTOR_BACKEND = 'openai-compatible-tools';
		process.env.MEMORY_EXTRACTOR_MODEL = 'tool-extractor';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:9/v1';
		const sseChunks = [
			[
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call-1',
										function: {
											name: 'memory_set_attributes',
											arguments: JSON.stringify({
												entityKey: 'migrations',
												attributes: [
													{ predicate: 'decision', value: 'Use append-only migrations.' }
												]
											})
										}
									}
								]
							}
						}
					]
				}
			],
			[{ choices: [{ delta: { content: 'Stored the migration decision.' } }] }]
		];
		// Capture every request body sent to the model so we can inspect the
		// rendered packet the extractor was actually handed.
		const requestBodies: string[] = [];
		let chatCall = 0;
		const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
			if (typeof init?.body === 'string') requestBodies.push(init.body);
			const chunks = sseChunks[Math.min(chatCall, sseChunks.length - 1)];
			chatCall += 1;
			const text =
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(text, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const { users, convs, turnRunner } = await freshImports();
			const messages = await import('../src/lib/server/db/repos/messages');
			const memory = await import('../src/lib/server/db/repos/memory');
			const { commitPatch } = await import('../src/lib/server/memory/engine');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, {
				title: 'mem retry packet',
				workdir: wd,
				model: 'gpt-4'
			});
			const userMsg = messages.append(conv.id, {
				role: 'user',
				content: 'Remember we chose append-only migrations.'
			});
			const assistantMsg = messages.append(conv.id, { role: 'assistant', content: 'Done.' });

			// The latest turn's prior committed patch, pinned to this turn's
			// assistant message. A naive re-extraction packet would surface this
			// stale fact as already-recorded; the turn-start view must NOT.
			const prior = commitPatch({
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-1',
				sourceMessageId: assistantMsg.id,
				patch: {
					entities: [{ entityKey: 'migrations', entityType: 'topic', displayName: 'Migrations' }],
					facts: [{ entityKey: 'migrations', predicate: 'decision', value: 'Stale decision.' }]
				}
			});
			expect(prior.patch.status).toBe('committed');

			const turn = await turnRunner.startExtractionRetryTurn({
				conversationId: conv.id,
				userId: user.id,
				assistantMessageId: assistantMsg.id,
				assistantContent: assistantMsg.content,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					patchTurnId: 'turn-1',
					priorPatchId: prior.patch.id
				}
			});

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'committed')
			).toBeTruthy();

			// The extractor was prompted at least once, and NONE of those prompts
			// contained the prior turn's committed output — it saw memory as of turn
			// start, so it re-records the decision instead of skipping it.
			expect(requestBodies.length).toBeGreaterThan(0);
			expect(requestBodies.some((body) => body.includes('Stale decision.'))).toBe(false);

			// And the rerun did re-record it (durable replacement landed).
			expect(memory.listFacts(conv.id).map((f) => f.value)).toContain(
				'Use append-only migrations.'
			);
		} finally {
			delete process.env.MEMORY_EXTRACTOR_BACKEND;
			delete process.env.MEMORY_EXTRACTOR_MODEL;
			delete process.env.OPENAI_COMPATIBLE_BASE_URL;
			vi.unstubAllGlobals();
		}
	});

	it('on retry timeout surfaces needs_review (not cancelled) and preserves the prior patch', async () => {
		process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS = '40';
		process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS = '40';

		let capturedSignal: AbortSignal | undefined;
		vi.resetModules();
		await setupLocalEnv();
		vi.doMock('../src/lib/server/memory/extractor', async () => {
			const actual = await vi.importActual<typeof import('../src/lib/server/memory/extractor')>(
				'../src/lib/server/memory/extractor'
			);
			return {
				...actual,
				// Hang without observing the abort signal and without ever invoking
				// beforeCommit, so only the watchdog can end it.
				extractAndCommitMemory: vi.fn((input: { signal?: AbortSignal }) => {
					capturedSignal = input.signal;
					return new Promise(() => {});
				})
			};
		});
		try {
			const users = await import('../src/lib/server/db/repos/users');
			const convs = await import('../src/lib/server/db/repos/conversations');
			const messages = await import('../src/lib/server/db/repos/messages');
			const memory = await import('../src/lib/server/db/repos/memory');
			const turnRunner = await import('../src/lib/server/runtime/turn-runner');
			const { commitPatch } = await import('../src/lib/server/memory/engine');
			const user = users.ensureLocalUser();
			const wd = makeTmpDir('portal-wd-');
			const conv = convs.create(user.id, {
				title: 'mem retry timeout',
				workdir: wd,
				model: 'gpt-4'
			});
			const userMsg = messages.append(conv.id, { role: 'user', content: 'remember this' });
			const assistantMsg = messages.append(conv.id, { role: 'assistant', content: 'Done.' });

			const prior = commitPatch({
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-1',
				sourceMessageId: assistantMsg.id,
				patch: {
					entities: [{ entityKey: 'migrations', entityType: 'topic', displayName: 'Migrations' }],
					facts: [{ entityKey: 'migrations', predicate: 'decision', value: 'Stale decision.' }]
				}
			});
			expect(prior.patch.status).toBe('committed');

			const turn = await turnRunner.startExtractionRetryTurn({
				conversationId: conv.id,
				userId: user.id,
				assistantMessageId: assistantMsg.id,
				assistantContent: assistantMsg.content,
				memory: {
					mode: 'project',
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					patchTurnId: 'turn-1',
					priorPatchId: prior.patch.id
				}
			});

			const events: PortalEvent[] = [];
			for await (const { event } of turn.subscribe()) {
				events.push(event);
				if (event.type === 'done') break;
			}

			// A watchdog timeout is a failure, not a user cancellation: it ends the
			// turn cleanly and surfaces needs_review, never the `skipped`/cancelled
			// status reserved for a user Stop.
			expect(events.find((e) => e.type === 'done')).toMatchObject({
				type: 'done',
				status: 'complete'
			});
			expect(
				events.find((e) => e.type === 'memory.status' && e.phase === 'needs_review')
			).toBeTruthy();
			expect(events.find((e) => e.type === 'memory.status' && e.phase === 'skipped')).toBeFalsy();
			expect(capturedSignal?.aborted).toBe(true);

			// The prior patch survives the failed retry untouched (no data loss).
			expect(memory.listPatches(conv.id).find((p) => p.id === prior.patch.id)?.status).toBe(
				'committed'
			);
			expect(memory.listFacts(conv.id).map((f) => f.value)).toContain('Stale decision.');
		} finally {
			vi.doUnmock('../src/lib/server/memory/extractor');
			delete process.env.MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS;
			delete process.env.MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS;
		}
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
