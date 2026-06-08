import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupLocalEnv } from './helpers/env';

async function freshImports() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const memory = await import('../src/lib/server/db/repos/memory');
	const engine = await import('../src/lib/server/memory/engine');
	const db = await import('../src/lib/server/db');
	const snapshots = await import('../src/lib/server/snapshots');
	const fork = await import('../src/lib/server/fork');
	return { users, convs, messages, memory, engine, db, snapshots, fork };
}

describe('fork.forkAtMessage', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-fork-test-');
	});

	function workdirFor(convId: string): string {
		const dir = resolve(dataDir, 'workspaces', convId);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('clones prior history + the edited message and shares the source workdir', async () => {
		const { users, convs, messages, snapshots, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('shared');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: 'gpt-4' });

		// Turn 1: pre-snapshot then assistant reply.
		writeFileSync(join(wd, 'state.txt'), 'v1\n');
		const u1 = messages.append(sourceConv.id, { role: 'user', content: 'first' });
		await snapshots.snapshot(wd, u1.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });

		// Turn 2: workdir mutates, pre-snapshot, assistant reply.
		writeFileSync(join(wd, 'state.txt'), 'v2\n');
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });
		await snapshots.snapshot(wd, u2.id, 'pre');
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 2' });

		// Workdir evolves further after the source thread.
		writeFileSync(join(wd, 'state.txt'), 'v3\n');

		// Edit turn 2's user message.
		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u2.id,
			newContent: 'second (edited)'
		});

		const newConv = result.conversation;
		expect(newConv.forkedFromConversationId).toBe(sourceConv.id);
		expect(newConv.forkedFromMessageId).toBe(u2.id);

		// Forked conversation shares the source workdir (no materialize).
		expect(newConv.workdir).toBe(sourceConv.workdir);
		// And the workdir is NOT rolled back — it still reflects the live state.
		expect(readFileSync(join(wd, 'state.txt'), 'utf8')).toBe('v3\n');

		// The new conversation has: u1, a1 (cloned) + the edited u2 (fresh).
		const cloned = messages.listByConversation(newConv.id);
		expect(cloned).toHaveLength(3);
		expect(cloned[0]).toMatchObject({ role: 'user', content: 'first' });
		expect(cloned[1]).toMatchObject({ role: 'assistant', content: 'reply 1' });
		expect(cloned[2]).toMatchObject({ role: 'user', content: 'second (edited)' });

		// IDs are fresh, not reused from source.
		const sourceIds = new Set(messages.listByConversation(sourceConv.id).map((m) => m.id));
		for (const m of cloned) expect(sourceIds.has(m.id)).toBe(false);

		// Source is untouched.
		expect(messages.listByConversation(sourceConv.id)).toHaveLength(4);
	});

	it('rejects edits on assistant messages when newContent is provided', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		const a = messages.append(conv.id, { role: 'assistant', content: 'reply' });
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: a.id,
				newContent: 'nope'
			})
		).rejects.toMatchObject({ reason: 'content_not_allowed' });
	});

	it('requires newContent when editing a user message', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		const m = messages.append(conv.id, { role: 'user', content: 'hi' });
		await expect(
			fork.forkAtMessage({
				userId: u.id,
				sourceConversationId: conv.id,
				messageId: m.id,
				newContent: null
			})
		).rejects.toMatchObject({ reason: 'content_required' });
	});

	it('retries from an assistant message: clones up to and including it, no new user msg', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('shared-retry');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });
		messages.append(sourceConv.id, { role: 'user', content: 'second' });

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: a1.id,
			newContent: null
		});

		const newConv = result.conversation;
		expect(newConv.forkedFromMessageId).toBe(a1.id);
		expect(newConv.workdir).toBe(sourceConv.workdir);
		const cloned = messages.listByConversation(newConv.id);
		expect(cloned).toHaveLength(2);
		expect(cloned[0]).toMatchObject({ role: 'user', content: 'first' });
		expect(cloned[1]).toMatchObject({ role: 'assistant', content: 'reply 1' });
	});

	it('carries prefix session memory into the fork but leaves rewound-suffix memory behind', async () => {
		const { users, convs, messages, memory, engine, db, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('shared-memory');
		const sourceConv = convs.create(u.id, {
			title: 'src',
			workdir: wd,
			model: null,
			memoryMode: 'project'
		});

		// Turn 1: durable memory attributed to the assistant reply a1.
		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });
		const prefixCommit = engine.commitPatch({
			conversationId: sourceConv.id,
			sourceMessageId: a1.id,
			patch: {
				entities: [{ entityKey: 'object.key', entityType: 'object', displayName: 'Brass key' }],
				facts: [{ entityKey: 'object.key', predicate: 'location', value: 'study' }],
				decisions: [
					{ subject: 'plan', decision: 'Search the study first.' },
					{ subject: 'stale-plan', decision: 'Use the discarded plan.' }
				],
				openLoops: [
					{ loopType: 'task', title: 'Inspect the study', relatedEntityKeys: ['object.key'] }
				]
			}
		});

		const prefixDecisions = memory.listDecisions(sourceConv.id, { limit: 10 });
		const keptDecision = prefixDecisions.find((d) => d.decision === 'Search the study first.')!;
		const staleDecision = prefixDecisions.find((d) => d.subject === 'stale-plan')!;
		memory.updateDecision(sourceConv.id, keptDecision.id, {
			decision: 'Search the study cautiously.'
		});
		expect(memory.deleteItem(sourceConv.id, 'decisions', staleDecision.id)).toBe(true);
		const entityPatchItem = memory
			.listPatchItems(sourceConv.id, { patchId: prefixCommit.patch.id, limit: 20 })
			.find((item) => item.itemType === 'entity')!;
		memory.reviewPatchItem(sourceConv.id, entityPatchItem.id, 'approve');

		// Turn 2: the turn that will be rewound away. Its memory must NOT survive.
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });
		const a2 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 2' });
		engine.commitPatch({
			conversationId: sourceConv.id,
			sourceMessageId: a2.id,
			patch: {
				entities: [
					{
						entityKey: 'object.key',
						entityType: 'object',
						displayName: 'Brass key',
						summary: 'Suffix-only update that must not survive.'
					},
					{ entityKey: 'object.door', entityType: 'object', displayName: 'Locked door' }
				],
				facts: [{ entityKey: 'object.door', predicate: 'state', value: 'locked' }],
				decisions: [{ subject: 'plan', decision: 'Force the door open.' }]
			}
		});

		// Pin memory timestamps around the fork boundary (u2's real created_at)
		// without touching the messages table — message ordering is by
		// created_at, so rewriting message timestamps would reorder history.
		// Linked memory (facts/decisions/loops/events) is deliberately pinned
		// AFTER the boundary to simulate late async extraction: it must still be
		// carried over because it is linked to a kept prefix message, proving the
		// clone classifies by source_message_id rather than the timestamp.
		// Entities have no message link, so they are still split by the boundary.
		const conn = db.getDb();
		const boundary = u2.createdAt;
		for (const table of [
			'memory_facts',
			'memory_decisions',
			'memory_open_loops',
			'memory_events'
		]) {
			conn
				.prepare(`UPDATE ${table} SET created_at = ? WHERE source_message_id = ?`)
				.run(boundary + 100, a1.id);
			conn
				.prepare(`UPDATE ${table} SET created_at = ? WHERE source_message_id = ?`)
				.run(boundary + 100, a2.id);
		}
		// Entities have no source_message_id; pin them by key around the boundary.
		conn
			.prepare(`UPDATE memory_entities SET created_at = ? WHERE entity_key = 'object.key'`)
			.run(boundary - 100);
		conn
			.prepare(`UPDATE memory_entities SET created_at = ? WHERE entity_key = 'object.door'`)
			.run(boundary + 100);

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u2.id,
			newContent: 'second (edited)'
		});
		const forkId = result.conversation.id;

		// Prefix memory carried over.
		expect(memory.listEntities(forkId).map((e) => e.entityKey)).toEqual(['object.key']);
		expect(memory.listEntities(forkId)[0].summary).toBe('');
		const facts = memory.listFacts(forkId);
		expect(facts.map((f) => f.predicate)).toEqual(['location']);
		expect(memory.listDecisions(forkId).map((d) => d.decision)).toEqual([
			'Search the study cautiously.'
		]);
		const loops = memory.listOpenLoops(forkId);
		expect(loops.map((l) => l.title)).toEqual(['Inspect the study']);

		// Rewound-suffix memory left behind.
		expect(memory.listEntities(forkId).map((e) => e.entityKey)).not.toContain('object.door');
		expect(memory.listDecisions(forkId).map((d) => d.decision)).not.toContain(
			'Force the door open.'
		);
		expect(memory.listDecisions(forkId).map((d) => d.decision)).not.toContain(
			'Use the discarded plan.'
		);

		// Internal references are remapped to the clone's own rows/transcript.
		const clonedAssistant = messages
			.listByConversation(forkId)
			.find((m) => m.role === 'assistant' && m.content === 'reply 1')!;
		expect(facts[0].sourceMessageId).toBe(clonedAssistant.id);
		const forkEntityId = memory.listEntities(forkId)[0].id;
		expect(facts[0].entityId).toBe(forkEntityId);
		expect(loops[0].relatedEntityIds).toEqual([forkEntityId]);

		// Cloned memory is independently searchable in the fork.
		expect(memory.search(forkId, { query: 'study key' }).length).toBeGreaterThan(0);
		expect(
			memory.listPatchItems(forkId).find((item) => item.itemType === 'entity')?.reviewStatus
		).toBe('approved');

		// The source conversation keeps everything (non-destructive fork).
		expect(
			memory
				.listEntities(sourceConv.id)
				.map((e) => e.entityKey)
				.sort()
		).toEqual(['object.door', 'object.key']);
	});

	it('inherits pinned per-session directives into the fork', async () => {
		const { users, convs, messages, memory, engine, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('directive-fork');
		const sourceConv = convs.create(u.id, {
			title: 'src',
			workdir: wd,
			model: null,
			memoryMode: 'story'
		});

		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });
		engine.commitPatch({
			conversationId: sourceConv.id,
			mode: 'story',
			sourceMessageId: a1.id,
			patch: {
				facts: [{ predicate: 'directive', value: 'When creating new characters, give them names.' }]
			}
		});
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });
		messages.append(sourceConv.id, { role: 'assistant', content: 'reply 2' });

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u2.id,
			newContent: 'second (edited)'
		});
		const forkId = result.conversation.id;

		const inherited = memory.listFacts(forkId, { predicate: 'directive', limit: 10 });
		expect(inherited.map((d) => d.value)).toEqual([
			'When creating new characters, give them names.'
		]);
		expect(inherited[0].pinned).toBe(true);

		const packet = engine.buildInitialPacket(forkId, 'story');
		expect(packet.directives.map((d) => d.value)).toContain(
			'When creating new characters, give them names.'
		);
	});
});
