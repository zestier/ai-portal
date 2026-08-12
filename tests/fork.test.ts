import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupLocalEnv } from './helpers/env';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../src/lib/server/global-singleton';

// Register a fake "running" turn for `conversationId` in the shared turn
// registry so `getTurn()` reports the source as busy, without spinning up a
// real provider turn. Returns a cleanup that removes it again.
function markConversationBusy(conversationId: number): () => void {
	const registry = getOrCreateGlobalSingleton<Map<number, { status: string }>>(
		appGlobalSymbols('turns'),
		() => new Map()
	);
	registry.set(conversationId, { status: 'running' });
	return () => registry.delete(conversationId);
}

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
	let cleanupBusy: (() => void) | null = null;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-fork-test-');
		process.env.WORKTREE_ROOT = join(dataDir, 'managed-worktrees');
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();
	});

	afterEach(() => {
		cleanupBusy?.();
		cleanupBusy = null;
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

	it('carries auto-deny into a fork but never auto-approve', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();

		// auto-deny used to ride on `mode: 'best-effort'`, which forks copied —
		// so an unattended fork kept auto-rejecting instead of silently blocking
		// on a dialog nobody is watching. The separate approve-all boolean was
		// deliberately NOT copied. Both halves must survive the axis split.
		const denySource = convs.create(u.id, {
			title: 'deny src',
			workdir: workdirFor('fork-deny'),
			model: 'gpt-4',
			mode: 'autopilot',
			approvalMode: 'auto-deny'
		});
		const denyUser = messages.append(denySource.id, { role: 'user', content: 'go' });
		messages.append(denySource.id, { role: 'assistant', content: 'ok' });
		const denyFork = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: denySource.id,
			messageId: denyUser.id,
			newContent: 'go (edited)'
		});
		expect(denyFork.conversation).toMatchObject({ mode: 'autopilot', approvalMode: 'auto-deny' });

		const approveSource = convs.create(u.id, {
			title: 'approve src',
			workdir: workdirFor('fork-approve'),
			model: 'gpt-4',
			approvalMode: 'auto-approve'
		});
		const approveUser = messages.append(approveSource.id, { role: 'user', content: 'go' });
		messages.append(approveSource.id, { role: 'assistant', content: 'ok' });
		const approveFork = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: approveSource.id,
			messageId: approveUser.id,
			newContent: 'go (edited)'
		});
		expect(approveFork.conversation.approvalMode).toBe('ask');
	});

	it('carries the adversary review model into a fork', async () => {
		// The shadow reviewer configures a measurement and has no authority, so
		// unlike `approvalMode` there is no safety asymmetry — a fork should
		// continue the same measurement rather than silently falling back to the
		// user/server default.
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const source = convs.create(u.id, {
			title: 'adversary src',
			workdir: workdirFor('fork-adversary'),
			model: 'gpt-4',
			adversaryModel: 'reviewer-x'
		});
		const userMsg = messages.append(source.id, { role: 'user', content: 'go' });
		messages.append(source.id, { role: 'assistant', content: 'ok' });
		const forked = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: source.id,
			messageId: userMsg.id,
			newContent: 'go (edited)'
		});
		expect(forked.conversation.adversaryModel).toBe('reviewer-x');
	});

	it('creates an isolated worktree at the historical snapshot state', async () => {
		const { users, convs, messages, snapshots, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('isolated-source');
		execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: wd });
		execFileSync('git', ['config', 'user.name', 'Portal Test'], { cwd: wd });
		execFileSync('git', ['config', 'user.email', 'portal-test@localhost'], { cwd: wd });
		writeFileSync(join(wd, 'state.txt'), 'base\n');
		execFileSync('git', ['add', 'state.txt'], { cwd: wd });
		execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: wd });
		const source = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		writeFileSync(join(wd, 'state.txt'), 'historical\n');
		writeFileSync(join(wd, 'untracked.txt'), 'captured\n');
		const target = messages.append(source.id, { role: 'user', content: 'change it' });
		await snapshots.snapshot(wd, target.id, 'pre');
		writeFileSync(join(wd, 'state.txt'), 'current\n');

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: source.id,
			messageId: target.id,
			newContent: 'change it differently',
			workspaceKind: 'managed-worktree'
		});

		expect(result.deferred).toBe(false);
		expect(result.conversation.workspaceKind).toBe('managed-worktree');
		expect(result.conversation.workspaceKey).toBe(source.workspaceKey);
		expect(result.conversation.workdir).not.toBe(source.workdir);
		expect(readFileSync(join(result.conversation.workdir, 'state.txt'), 'utf8')).toBe(
			'historical\n'
		);
		expect(readFileSync(join(result.conversation.workdir, 'untracked.txt'), 'utf8')).toBe(
			'captured\n'
		);
		expect(readFileSync(join(source.workdir, 'state.txt'), 'utf8')).toBe('current\n');
		const status = execFileSync('git', ['status', '--porcelain'], {
			cwd: result.conversation.workdir,
			encoding: 'utf8'
		});
		expect(status).toContain(' M state.txt');
		expect(status).toContain('?? untracked.txt');
	});

	it('creates an isolated worktree from a legacy snapshot without a recorded base commit', async () => {
		const { users, convs, messages, snapshots, fork, db } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('legacy-snapshot-source');
		execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: wd });
		execFileSync('git', ['config', 'user.name', 'Portal Test'], { cwd: wd });
		execFileSync('git', ['config', 'user.email', 'portal-test@localhost'], { cwd: wd });
		writeFileSync(join(wd, 'state.txt'), 'base\n');
		execFileSync('git', ['add', 'state.txt'], { cwd: wd });
		execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: wd });
		const source = convs.create(u.id, { title: 'src', workdir: wd, model: null });
		writeFileSync(join(wd, 'state.txt'), 'historical\n');
		const target = messages.append(source.id, { role: 'user', content: 'change it' });
		await snapshots.snapshot(wd, target.id, 'pre');
		db.getDb()
			.prepare('UPDATE turn_snapshots SET base_commit_sha = NULL WHERE message_id = ?')
			.run(target.id);
		writeFileSync(join(wd, 'state.txt'), 'new head\n');
		execFileSync('git', ['add', 'state.txt'], { cwd: wd });
		execFileSync('git', ['commit', '-q', '-m', 'new head'], { cwd: wd });
		const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: wd,
			encoding: 'utf8'
		}).trim();

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: source.id,
			messageId: target.id,
			newContent: 'change it differently',
			workspaceKind: 'managed-worktree'
		});

		expect(result.conversation.worktreeBaseSha).toBe(currentHead);
		expect(readFileSync(join(result.conversation.workdir, 'state.txt'), 'utf8')).toBe(
			'historical\n'
		);
		expect(
			execFileSync('git', ['status', '--porcelain'], {
				cwd: result.conversation.workdir,
				encoding: 'utf8'
			})
		).toContain(' M state.txt');
	});

	it('gives a managed-source fork an independent worktree with a stable repository source', async () => {
		const { users, convs, messages, snapshots, fork, db } = await freshImports();
		const { createManagedWorktree, removeManagedWorktree } =
			await import('../src/lib/server/worktrees');
		const u = users.ensureLocalUser();
		const repository = workdirFor('managed-parent-source');
		execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
		execFileSync('git', ['config', 'user.name', 'Portal Test'], { cwd: repository });
		execFileSync('git', ['config', 'user.email', 'portal-test@localhost'], { cwd: repository });
		writeFileSync(join(repository, 'state.txt'), 'base\n');
		execFileSync('git', ['add', 'state.txt'], { cwd: repository });
		execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repository });
		const parent = convs.create(u.id, {
			title: 'managed parent',
			workdir: repository,
			workspaceKind: 'shared',
			workspaceKey: repository,
			model: null
		});
		const parentWorktree = await createManagedWorktree({
			sourceWorkdir: repository,
			userId: String(u.id),
			conversationId: String(parent.id)
		});
		// Mirror the conversations route: a managed worktree conversation's row
		// carries workspace_kind='managed-worktree' and a managed_worktrees row
		// (the fork below keys off both).
		db.getDb().transaction(() => {
			convs.setManagedWorktree(parent.id, parentWorktree);
			db.getDb()
				.prepare('UPDATE conversations SET workspace_kind = ? WHERE id = ?')
				.run('managed-worktree', parent.id);
		})();
		const target = messages.append(parent.id, { role: 'user', content: 'change it' });
		await snapshots.snapshot(parent.workdir, target.id, 'pre');

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: parent.id,
			messageId: target.id,
			newContent: 'change it differently'
		});
		const childWorktree = convs.getManagedWorktree(result.conversation.id, u.id);

		expect(result.conversation.workspaceKind).toBe('managed-worktree');
		expect(childWorktree?.sourceWorkdir).toBe(repository);
		await removeManagedWorktree(parentWorktree, { force: true });
		await expect(removeManagedWorktree(childWorktree!, { force: true })).resolves.toBeUndefined();
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
				facts: [
					{ entityKey: 'object.key', predicate: 'location', value: 'study' },
					{ entityKey: 'object.key', predicate: 'stale_plan', value: 'Use the discarded plan.' }
				],
				openLoops: [
					{ loopType: 'task', title: 'Inspect the study', relatedEntityKeys: ['object.key'] }
				]
			}
		});

		const staleFact = memory
			.listFacts(sourceConv.id, { limit: 10 })
			.find((f) => f.predicate === 'stale_plan')!;
		expect(memory.deleteItem(sourceConv.id, 'facts', staleFact.id)).toBe(true);
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
				facts: [{ entityKey: 'object.door', predicate: 'state', value: 'locked' }]
			}
		});

		// Pin memory timestamps around the fork boundary (u2's real created_at)
		// without touching the messages table — message ordering is by
		// created_at, so rewriting message timestamps would reorder history.
		// Linked memory (facts/loops/events) is deliberately pinned
		// AFTER the boundary to simulate late async extraction: it must still be
		// carried over because it is linked to a kept prefix message, proving the
		// clone classifies by source_message_id rather than the timestamp.
		// Entities have no message link, so they are still split by the boundary.
		const conn = db.getDb();
		const boundary = u2.createdAt;
		for (const table of ['memory_facts', 'memory_open_loops', 'memory_events']) {
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
		const loops = memory.listOpenLoops(forkId);
		expect(loops.map((l) => l.title)).toEqual(['Inspect the study']);

		// Rewound-suffix memory left behind.
		expect(memory.listEntities(forkId).map((e) => e.entityKey)).not.toContain('object.door');

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

	it('edit-fork while the source is running defers: no trailing user row, persists draft', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('busy-edit');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });
		void a1;
		const u2 = messages.append(sourceConv.id, { role: 'user', content: 'second' });

		cleanupBusy = markConversationBusy(sourceConv.id);

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u2.id,
			newContent: 'second (edited)'
		});

		// Deferred: no user row appended; edited text persisted as the draft.
		expect(result.deferred).toBe(true);
		expect(result.userMessage).toBeNull();
		// The edited text is persisted as the fork's composer draft so it
		// survives reload/navigation and is seeded into the composer on load.
		expect(result.conversation.draftPrompt).toBe('second (edited)');

		// The fork holds only the prefix (no dangling trailing user message).
		const cloned = messages.listByConversation(result.conversation.id);
		expect(cloned.map((m) => `${m.role}:${m.content}`)).toEqual([
			'user:first',
			'assistant:reply 1'
		]);

		// Source untouched.
		expect(messages.listByConversation(sourceConv.id)).toHaveLength(3);
	});

	it('retry-fork works while the source is running (no auto-start, clones through target)', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('busy-retry');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		messages.append(sourceConv.id, { role: 'user', content: 'first' });
		const a1 = messages.append(sourceConv.id, { role: 'assistant', content: 'reply 1' });

		cleanupBusy = markConversationBusy(sourceConv.id);

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: a1.id,
			newContent: null
		});

		expect(result.userMessage).toBeNull();
		// Retry-forks never carry a composer draft (only deferred edit-forks do).
		expect(result.conversation.draftPrompt).toBeNull();
		const cloned = messages.listByConversation(result.conversation.id);
		expect(cloned.map((m) => `${m.role}:${m.content}`)).toEqual([
			'user:first',
			'assistant:reply 1'
		]);
	});

	it('edit-fork while the source is idle still auto-starts (appends the user row)', async () => {
		const { users, convs, messages, fork } = await freshImports();
		const u = users.ensureLocalUser();
		const wd = workdirFor('idle-edit');
		const sourceConv = convs.create(u.id, { title: 'src', workdir: wd, model: null });

		const u1 = messages.append(sourceConv.id, { role: 'user', content: 'first' });

		const result = await fork.forkAtMessage({
			userId: u.id,
			sourceConversationId: sourceConv.id,
			messageId: u1.id,
			newContent: 'first (edited)'
		});

		expect(result.deferred).toBe(false);
		expect(result.conversation.draftPrompt).toBeNull();
		expect(result.userMessage).toMatchObject({ role: 'user', content: 'first (edited)' });
	});
});
