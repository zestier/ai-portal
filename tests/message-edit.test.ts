import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const memory = await import('../src/lib/server/db/repos/memory');
	const usage = await import('../src/lib/server/db/repos/usage');
	const edit = await import('../src/lib/server/message-edit');
	const engine = await import('../src/lib/server/memory/engine');
	const db = await import('../src/lib/server/db');
	return { users, convs, messages, memory, usage, edit, engine, db };
}

describe('message-edit.inlineEditMessage', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-message-edit-test-');
	});

	it('updates the selected user message and transactionally removes later dependent rows', async () => {
		const { users, convs, messages, usage, edit, db } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'src', workdir: '/tmp', model: null });
		const originalProviderSessionId = conv.providerSessionId;

		const u1 = messages.append(conv.id, { role: 'user', content: 'original' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		messages.insertToolCall(a1.id, {
			id: 'tool-later',
			tool: 'task',
			argsJson: '{}',
			resultJson: null,
			status: 'ok',
			startedAt: Date.now(),
			endedAt: Date.now(),
			textOffset: 0,
			parentToolCallId: null
		});
		messages.updateBackgroundAgentLifecycle('tool-later', 'agent-later', 'running');
		messages.insertFileEdit(a1.id, 'file.txt', 'diff', 0);
		messages.insertReasoningBlock(a1.id, {
			id: 'reason-later',
			segmentIndex: 0,
			text: 'thinking',
			textOffset: 0,
			startedAt: Date.now(),
			durationMs: 10,
			parentToolCallId: null
		});
		messages.append(conv.id, { role: 'user', content: 'later user' });
		usage.upsert(conv.id, {
			currentTokens: 9000,
			tokenLimit: 128_000,
			messagesLength: 3
		});

		const result = edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u1.id,
			newContent: 'edited'
		});

		expect(result.userMessage).toMatchObject({ id: u1.id, content: 'edited', role: 'user' });
		expect(result.conversation.providerSessionId).not.toBe(originalProviderSessionId);
		expect(messages.listByConversation(conv.id)).toMatchObject([
			{ id: u1.id, role: 'user', content: 'edited' }
		]);
		expect(usage.get(conv.id)).toBeNull();

		const database = db.getDb();
		expect(database.prepare('SELECT count(*) AS n FROM tool_calls').get()).toMatchObject({ n: 0 });
		expect(database.prepare('SELECT count(*) AS n FROM file_edits').get()).toMatchObject({ n: 0 });
		expect(database.prepare('SELECT count(*) AS n FROM reasoning_blocks').get()).toMatchObject({
			n: 0
		});
		expect(
			database.prepare('SELECT count(*) AS n FROM background_agent_lifecycles').get()
		).toMatchObject({ n: 0 });
	});

	it('rewinds session memory to the edited message prefix before deleting later messages', async () => {
		const { users, convs, messages, memory, edit, engine } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'src',
			workdir: '/tmp',
			model: null,
			memoryMode: 'project'
		});

		messages.append(conv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		engine.commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a1.id,
			patch: {
				entities: [{ entityKey: 'topic.keep', entityType: 'topic', displayName: 'Keep' }],
				facts: [{ entityKey: 'topic.keep', predicate: 'state', value: 'kept' }]
			}
		});
		const u2 = messages.append(conv.id, { role: 'user', content: 'second' });
		const a2 = messages.append(conv.id, { role: 'assistant', content: 'reply 2' });
		engine.commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a2.id,
			patch: {
				entities: [{ entityKey: 'topic.drop', entityType: 'topic', displayName: 'Drop' }],
				facts: [{ entityKey: 'topic.drop', predicate: 'state', value: 'stale' }]
			}
		});

		edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u2.id,
			newContent: 'second edited'
		});

		expect(memory.listEntities(conv.id).map((entity) => entity.entityKey)).toEqual(['topic.keep']);
		expect(memory.listFacts(conv.id).map((fact) => fact.value)).toEqual(['kept']);
		expect(messages.listByConversation(conv.id).map((message) => message.id)).toEqual([
			expect.any(String),
			a1.id,
			u2.id
		]);
	});

	it('garbage-collects orphaned memory log events and refs after rewinding', async () => {
		const { users, convs, messages, edit, engine, db } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'gc',
			workdir: '/tmp',
			model: null,
			memoryMode: 'project'
		});

		messages.append(conv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		engine.commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a1.id,
			patch: {
				entities: [{ entityKey: 'topic.keep', entityType: 'topic', displayName: 'Keep' }]
			}
		});
		const u2 = messages.append(conv.id, { role: 'user', content: 'second' });
		const a2 = messages.append(conv.id, { role: 'assistant', content: 'reply 2' });
		engine.commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a2.id,
			patch: {
				entities: [{ entityKey: 'topic.drop', entityType: 'topic', displayName: 'Drop' }]
			}
		});

		const database = db.getDb();
		const eventCount = () =>
			(
				database
					.prepare('SELECT count(*) AS n FROM memory_event_log WHERE conversation_id = ?')
					.get(conv.id) as { n: number }
			).n;
		const refCount = () =>
			(
				database
					.prepare('SELECT count(*) AS n FROM memory_refs WHERE conversation_id = ?')
					.get(conv.id) as { n: number }
			).n;
		const beforeEvents = eventCount();
		expect(beforeEvents).toBeGreaterThan(0);
		expect(refCount()).toBeGreaterThan(0);

		edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u2.id,
			newContent: 'second edited'
		});

		// The suffix events (topic.drop) and their refs are physically removed,
		// while the kept prefix events survive.
		expect(eventCount()).toBeLessThan(beforeEvents);
		expect(eventCount()).toBeGreaterThan(0);
		// No ref may dangle past a deleted event, and every surviving event is
		// reachable from a remaining reference.
		const danglingRefs = database
			.prepare(
				`SELECT count(*) AS n
				   FROM memory_refs r
				  WHERE r.conversation_id = ?
				    AND NOT EXISTS (
				      SELECT 1 FROM memory_event_log e
				       WHERE e.id = r.target_event_id
				    )`
			)
			.get(conv.id) as { n: number };
		expect(danglingRefs.n).toBe(0);
	});

	it('cascades GC across all downstream turns when editing far up the conversation', async () => {
		const { users, convs, messages, memory, edit, engine, db } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'gc-far-up',
			workdir: '/tmp',
			model: null,
			memoryMode: 'project'
		});

		// Kept prefix: first user turn + its extraction.
		messages.append(conv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply 1' });
		engine.commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a1.id,
			patch: { entities: [{ entityKey: 'topic.keep', entityType: 'topic', displayName: 'Keep' }] }
		});
		const editTarget = messages.append(conv.id, { role: 'user', content: 'second' });

		// Three further downstream turns, each contributing its own memory. The
		// edit point (editTarget) sits well above all of them.
		for (const n of [1, 2, 3]) {
			const assistant = messages.append(conv.id, { role: 'assistant', content: `reply ${n + 1}` });
			engine.commitPatch({
				conversationId: conv.id,
				mode: 'project',
				sourceMessageId: assistant.id,
				patch: {
					entities: [{ entityKey: `topic.drop${n}`, entityType: 'topic', displayName: `Drop ${n}` }]
				}
			});
			messages.append(conv.id, { role: 'user', content: `user ${n + 2}` });
		}

		const database = db.getDb();
		const eventCount = () =>
			(
				database
					.prepare('SELECT count(*) AS n FROM memory_event_log WHERE conversation_id = ?')
					.get(conv.id) as { n: number }
			).n;
		const beforeEvents = eventCount();

		edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: editTarget.id,
			newContent: 'second edited'
		});

		// Every downstream turn's memory is gone; only the kept-prefix entity remains.
		expect(memory.listEntities(conv.id).map((entity) => entity.entityKey)).toEqual(['topic.keep']);
		expect(eventCount()).toBeLessThan(beforeEvents);

		// Invariant: with messages present, every surviving event must still be
		// referenced by something (a child's memory_parent ref, or a message_head).
		// A non-zero count here would mean GC stopped early and orphaned a branch.
		const orphanedEvents = database
			.prepare(
				`SELECT count(*) AS n
				   FROM memory_event_log e
				  WHERE e.conversation_id = ?
				    AND NOT EXISTS (
				      SELECT 1 FROM memory_refs r WHERE r.target_event_id = e.id
				    )`
			)
			.get(conv.id) as { n: number };
		expect(orphanedEvents.n).toBe(0);

		// And no reference points at a deleted event.
		const danglingRefs = database
			.prepare(
				`SELECT count(*) AS n
				   FROM memory_refs r
				  WHERE r.conversation_id = ?
				    AND NOT EXISTS (
				      SELECT 1 FROM memory_event_log e WHERE e.id = r.target_event_id
				    )`
			)
			.get(conv.id) as { n: number };
		expect(danglingRefs.n).toBe(0);
	});

	it('rejects assistant messages', async () => {
		const { users, convs, messages, edit } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 'src', workdir: '/tmp', model: null });
		const assistant = messages.append(conv.id, { role: 'assistant', content: 'reply' });

		expect(() =>
			edit.inlineEditMessage({
				userId: u.id,
				conversationId: conv.id,
				messageId: assistant.id,
				newContent: 'edited'
			})
		).toThrowError(expect.objectContaining({ reason: 'not_user_message' }));
	});
});
