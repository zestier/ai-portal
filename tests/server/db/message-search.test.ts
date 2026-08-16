import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from '../../helpers/env';
import { conversationId } from '../../../src/lib/ids';

async function freshImports() {
	const users = await import('../../../src/lib/server/db/repos/users');
	const convs = await import('../../../src/lib/server/db/repos/conversations');
	const messages = await import('../../../src/lib/server/db/repos/messages');
	const db = await import('../../../src/lib/server/db');
	return { users, convs, messages, db };
}

function ftsCount(
	db: { getDb: () => import('better-sqlite3').Database },
	convId: string | number
): number {
	const row = db
		.getDb()
		.prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE conversation_id = ?')
		.get(typeof convId === 'number' ? convId : conversationId.parse(convId)) as { n: number };
	return row.n;
}

describe('messages.searchConversation (FTS-backed)', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-msg-search-test-');
	});

	it('finds messages by literal substring and orders chronologically', async () => {
		const { users, convs, messages } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		messages.append(c.id, { role: 'user', content: 'deploy the alpha service' });
		messages.append(c.id, { role: 'assistant', content: 'rolling back beta' });
		messages.append(c.id, { role: 'user', content: 'alpha is fine now' });

		const hits = messages.searchConversation(c.id, 'alpha');
		expect(hits.map((m) => m.content)).toEqual(['deploy the alpha service', 'alpha is fine now']);
	});

	it('keeps exact-substring semantics (token must contain the phrase literally)', async () => {
		const { users, convs, messages } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		messages.append(c.id, { role: 'user', content: 'this is foobar text' });
		messages.append(c.id, { role: 'user', content: 'foo and bar separately' });

		expect(messages.searchConversation(c.id, 'foobar').map((m) => m.content)).toEqual([
			'this is foobar text'
		]);
		expect(messages.searchConversation(c.id, 'nomatch')).toEqual([]);
		// mid-word substrings still match (trigram tokenizer), case-insensitively
		expect(messages.searchConversation(c.id, 'ooba').map((m) => m.content)).toEqual([
			'this is foobar text'
		]);
		expect(messages.searchConversation(c.id, 'FOOBAR')).toHaveLength(1);
	});

	it('is scoped to the conversation', async () => {
		const { users, convs, messages } = await freshImports();
		const u = users.ensureLocalUser();
		const a = convs.create(u.id, { title: 'a', workdir: '/tmp', model: null });
		const b = convs.create(u.id, { title: 'b', workdir: '/tmp', model: null });
		messages.append(a.id, { role: 'user', content: 'unique token zebra' });
		messages.append(b.id, { role: 'user', content: 'unique token zebra' });
		expect(messages.searchConversation(a.id, 'zebra')).toHaveLength(1);
	});

	it('respects the limit', async () => {
		const { users, convs, messages } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		for (let i = 0; i < 5; i++) messages.append(c.id, { role: 'user', content: `target ${i}` });
		expect(messages.searchConversation(c.id, 'target', { limit: 3 })).toHaveLength(3);
	});

	it('falls back for punctuation-only queries', async () => {
		const { users, convs, messages } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		messages.append(c.id, { role: 'user', content: 'price was $5 (cheap)' });
		expect(messages.searchConversation(c.id, '(cheap)')).toHaveLength(1);
		expect(messages.searchConversation(c.id, '   ')).toEqual([]);
		// 1-2 char terms can't use the trigram index but still match via scan fallback
		expect(messages.searchConversation(c.id, '$5')).toHaveLength(1);
	});

	it('keeps the FTS index synced on update and delete', async () => {
		const { users, convs, messages, db } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		const m = messages.append(c.id, { role: 'user', content: 'original keyword' });
		expect(messages.searchConversation(c.id, 'keyword')).toHaveLength(1);

		messages.updateContentOnly(m.id, 'replaced phrasing');
		expect(messages.searchConversation(c.id, 'keyword')).toHaveLength(0);
		expect(messages.searchConversation(c.id, 'replaced')).toHaveLength(1);

		messages.append(c.id, { role: 'user', content: 'tail message' });
		messages.truncateAfterAndUpdateUserMessage(c.id, m.id, 'replaced phrasing');
		expect(messages.searchConversation(c.id, 'tail')).toHaveLength(0);
		expect(ftsCount(db, c.id)).toBe(1);
	});

	it('purges FTS rows when a conversation is removed', async () => {
		const { users, convs, messages, db } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'c', workdir: '/tmp', model: null });
		messages.append(c.id, { role: 'user', content: 'will be gone' });
		expect(ftsCount(db, c.id)).toBe(1);
		convs.remove(c.id, u.id);
		expect(ftsCount(db, c.id)).toBe(0);
	});
});
