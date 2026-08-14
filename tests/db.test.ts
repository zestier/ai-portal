import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDb } from '../src/lib/server/db';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as settings from '../src/lib/server/db/repos/settings';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import type { SessionMode } from '../src/lib/types';

describe('db migrations + repos', () => {
	// Own PROJECT_ROOT so the workspace-key normalization assertion doesn't
	// couple to the host's PROJECT_ROOT or the test process cwd (which differ
	// in worktree sessions).
	let projectRoot: string;

	beforeEach(async () => {
		await setupLocalEnv();
		projectRoot = mkdtempSync(join(tmpdir(), 'portal-db-project-'));
		process.env.PROJECT_ROOT = projectRoot;
		await resetServerSingletons();
	});

	afterEach(() => {
		delete process.env.PROJECT_ROOT;
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it('runs migrations on open and creates tables', () => {
		const db = getDb();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'conversations',
				'file_edits',
				'messages',
				'permission_decisions',
				'permission_grants',
				'prompt_templates',
				'schema_migrations',
				'background_agent_lifecycles',
				'tool_calls',
				'user_settings',
				'user_tokens',
				'users'
			])
		);
	});

	it('ensures local user idempotently', () => {
		const a = users.ensureLocalUser();
		const b = users.ensureLocalUser();
		expect(a.id).toBe(b.id);
		expect(a.githubLogin).toBe('local');
	});

	it('round-trips a conversation with messages', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: 'm'
		});
		messages.append(c.id, { role: 'user', content: 'hello' });
		messages.append(c.id, { role: 'assistant', content: 'world' });
		const list = messages.listByConversation(c.id);
		expect(list.map((m) => m.content)).toEqual(['hello', 'world']);

		// Authorization: another user can't read it.
		const other = users.upsertGithub({
			githubLogin: 'other',
			githubId: 42,
			displayName: null,
			avatarUrl: null
		});
		expect(convs.get(c.id, other.id)).toBeNull();
		expect(convs.get(c.id, u.id)?.title).toBe('t');
	});

	it('normalizes the workspace key for conversations upgraded from before migration 061', () => {
		const u = users.ensureLocalUser();
		const legacyWorkdir = resolve(process.env.DATA_DIR!, 'workspaces', 'legacy-conversation');
		const c = convs.create(u.id, { title: 'legacy', workdir: legacyWorkdir, model: null });
		getDb().prepare('UPDATE conversations SET workspace_key = NULL WHERE id = ?').run(c.id);

		expect(convs.get(c.id, u.id)?.workspaceKey).toBe(projectRoot);
	});

	it('round-trips the approval mode independently of the session mode', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			mode: 'autopilot'
		});
		expect(convs.get(c.id, u.id)?.mode).toBe('autopilot');
		expect(convs.get(c.id, u.id)?.approvalMode).toBe('ask');
		expect(convs.updateSessionSettings(c.id, u.id, { approvalMode: 'auto-deny' })).toBe(true);
		expect(convs.get(c.id, u.id)).toMatchObject({ mode: 'autopilot', approvalMode: 'auto-deny' });
		// The axes are orthogonal: autopilot + auto-deny (unattended exploration
		// that never blocks on a dialog) is expressible since auto-deny stopped
		// riding on `best-effort`, which force-forwarded autopilot. The retired
		// `plan` mode value reads back as `interactive` rather than persisting.
		expect(
			convs.updateSessionSettings(c.id, u.id, { mode: 'plan' as unknown as SessionMode })
		).toBe(true);
		expect(convs.get(c.id, u.id)).toMatchObject({
			mode: 'interactive',
			approvalMode: 'auto-deny'
		});
	});

	it('seeds the approval mode at creation and normalizes a bogus value', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			approvalMode: 'auto-approve'
		});
		expect(convs.get(c.id, u.id)?.approvalMode).toBe('auto-approve');
		expect(
			convs.updateSessionSettings(c.id, u.id, {
				approvalMode: 'nonsense' as unknown as 'ask'
			})
		).toBe(true);
		expect(convs.get(c.id, u.id)?.approvalMode).toBe('ask');
	});

	it('round-trips the per-conversation adversary model, including clearing it', () => {
		const u = users.ensureLocalUser();
		// Unset is the OFF state and must stay distinguishable from a chosen
		// model: the runtime reads NULL as "fall back", so a blank that
		// round-tripped as '' would be a model id nobody configured.
		const bare = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		expect(convs.get(bare.id, u.id)?.adversaryModel).toBeNull();

		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			adversaryModel: 'reviewer-x'
		});
		expect(convs.get(c.id, u.id)?.adversaryModel).toBe('reviewer-x');
		expect(convs.updateSessionSettings(c.id, u.id, { adversaryModel: 'reviewer-y' })).toBe(true);
		expect(convs.get(c.id, u.id)?.adversaryModel).toBe('reviewer-y');
		// Explicitly clearing must land as NULL so the conversation falls back
		// to the server default rather than keeping a stale reviewer.
		expect(convs.updateSessionSettings(c.id, u.id, { adversaryModel: null })).toBe(true);
		expect(convs.get(c.id, u.id)?.adversaryModel).toBeNull();
	});

	it('seeds the adversary model from the user default without re-inheriting it later', () => {
		// Seed-only, exactly like the harvester defaults. The load-bearing half
		// is the second assertion: a user WITH a default must still be able to
		// switch the reviewer off for one conversation, because it ships tool
		// arguments to a third-party endpoint. A live user-default fallback
		// would silently re-enable it and make per-conversation opt-out
		// impossible.
		const u = users.ensureLocalUser();
		const seeded = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			adversaryModel: 'user-default-reviewer'
		});
		expect(convs.get(seeded.id, u.id)?.adversaryModel).toBe('user-default-reviewer');

		convs.updateSessionSettings(seeded.id, u.id, { adversaryModel: null });
		expect(convs.get(seeded.id, u.id)?.adversaryModel).toBeNull();
	});

	it('coerces a legacy best-effort mode value to autopilot on read', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		// Simulate a row written before migration 066 split the axes. The
		// migration rewrites these, but the normalizer is the backstop for a
		// connection that raced it (dev HMR) or a hand-edited row.
		getDb().prepare('UPDATE conversations SET mode = ? WHERE id = ?').run('best-effort', c.id);
		expect(convs.get(c.id, u.id)?.mode).toBe('autopilot');
	});

	it('permission grants scope by conversation and global', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: null });
		expect(settings.hasGrant(u.id, c.id, 'shell')).toBe(false);
		settings.addGrant({ userId: u.id, conversationId: c.id, tool: 'shell' });
		expect(settings.hasGrant(u.id, c.id, 'shell')).toBe(true);
		// '*' tool wildcard, user-global.
		settings.addGrant({ userId: u.id, conversationId: null, tool: '*' });
		expect(settings.hasGrant(u.id, c.id, 'read')).toBe(true);
	});

	it('indexes permission_grants(conversation_id) so the FK cascade is not a full scan', () => {
		const db = getDb();
		// SQLite uses an index for an ON DELETE CASCADE lookup only when the FK
		// column is the leftmost index column. There must be an index whose first
		// column is conversation_id (migration 056).
		const indexes = db.prepare("PRAGMA index_list('permission_grants')").all() as {
			name: string;
		}[];
		const leadsWithConversation = indexes.some((idx) => {
			const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as {
				seqno: number;
				name: string;
			}[];
			const first = cols.find((c) => c.seqno === 0);
			return first?.name === 'conversation_id';
		});
		expect(leadsWithConversation).toBe(true);
	});

	it('cascades permission_grants when its conversation is deleted', () => {
		const db = getDb();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'doomed', workdir: '/tmp', model: null });
		settings.addGrant({ userId: u.id, conversationId: c.id, tool: 'shell' });
		expect(
			(
				db
					.prepare('SELECT COUNT(*) AS n FROM permission_grants WHERE conversation_id = ?')
					.get(c.id) as { n: number }
			).n
		).toBe(1);
		convs.remove(c.id, u.id);
		expect(
			(
				db
					.prepare('SELECT COUNT(*) AS n FROM permission_grants WHERE conversation_id = ?')
					.get(c.id) as { n: number }
			).n
		).toBe(0);
	});

	it('migration 057 dedup makes pre-existing duplicate loop keys unique without new collisions', () => {
		// Replays the real migration SQL against a constructed pre-migration table
		// that holds the exact corruption the migration repairs, including the
		// tricky case where a naive `_<rowid>` suffix would collide with an
		// already-allocated `_N` key.
		const db = new Database(':memory:');
		try {
			db.exec(`CREATE TABLE memory_open_loops (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL,
				loop_key TEXT NOT NULL DEFAULT ''
			)`);
			const insert = db.prepare(
				'INSERT INTO memory_open_loops(id, conversation_id, loop_key) VALUES (?, ?, ?)'
			);
			// rowid 1 + 2: a race wrote `loop.x` twice. rowid 3: a later add saw
			// `loop.x` taken and legitimately allocated `loop.x_2`.
			insert.run('01ID00000000000000000000R1', 'conv', 'loop.x');
			insert.run('01ID00000000000000000000R2', 'conv', 'loop.x');
			insert.run('01ID00000000000000000000R3', 'conv', 'loop.x_2');
			// Two legacy empty-key rows must survive untouched (exempt from unique).
			insert.run('01ID00000000000000000000L1', 'conv', '');
			insert.run('01ID00000000000000000000L2', 'conv', '');

			const sql = readFileSync(
				resolve('tests/fixtures/migrations/057_memory_open_loop_key_unique.sql'),
				'utf8'
			);
			expect(() => db.exec(sql)).not.toThrow();

			const rows = db.prepare('SELECT loop_key FROM memory_open_loops').all() as {
				loop_key: string;
			}[];
			const nonEmpty = rows.map((r) => r.loop_key).filter((k) => k !== '');
			// All non-empty keys are now distinct, and the kept row retains the base.
			expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
			expect(nonEmpty).toContain('loop.x');
			expect(nonEmpty).toContain('loop.x_2');
			// Two empty-key rows coexist under the partial unique index.
			expect(rows.filter((r) => r.loop_key === '').length).toBe(2);
		} finally {
			db.close();
		}
	});

	it('migration 066 splits approve-all / best-effort onto the approval-mode axis', () => {
		// Replays the real migration SQL against a constructed pre-066 schema
		// holding each combination the backfill has to resolve, including the
		// overlap (approve-all + best-effort) whose precedence used to be an
		// accident of evaluation order.
		const db = new Database(':memory:');
		try {
			db.exec(`CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				mode TEXT NOT NULL DEFAULT 'interactive',
				approve_all_tools INTEGER NOT NULL DEFAULT 0
			)`);
			db.exec(`CREATE TABLE user_settings (
				user_id TEXT PRIMARY KEY,
				default_mode TEXT NOT NULL DEFAULT 'interactive'
			)`);
			db.exec(`CREATE TABLE prompt_templates (
				id TEXT PRIMARY KEY,
				conversation_mode TEXT
			)`);
			const conv = db.prepare(
				'INSERT INTO conversations(id, mode, approve_all_tools) VALUES (?, ?, ?)'
			);
			conv.run('plain', 'interactive', 0);
			conv.run('approve-all', 'plan', 1);
			conv.run('best-effort', 'best-effort', 0);
			// Overlap: approve-all won by evaluation order before 066, so it
			// must keep winning — and the stranded best-effort mode still has
			// to land on autopilot rather than persisting a retired value.
			conv.run('both', 'best-effort', 1);
			db.prepare('INSERT INTO user_settings(user_id, default_mode) VALUES (?, ?)').run(
				'u1',
				'best-effort'
			);
			db.prepare('INSERT INTO user_settings(user_id, default_mode) VALUES (?, ?)').run(
				'u2',
				'plan'
			);
			db.prepare('INSERT INTO prompt_templates(id, conversation_mode) VALUES (?, ?)').run(
				't-be',
				'best-effort'
			);
			db.prepare('INSERT INTO prompt_templates(id, conversation_mode) VALUES (?, ?)').run(
				't-none',
				null
			);

			const sql = readFileSync(resolve('tests/fixtures/migrations/066_approval_mode.sql'), 'utf8');
			expect(() => db.exec(sql)).not.toThrow();

			const rows = Object.fromEntries(
				(
					db.prepare('SELECT id, mode, approval_mode FROM conversations').all() as {
						id: string;
						mode: string;
						approval_mode: string;
					}[]
				).map((r) => [r.id, r])
			);
			expect(rows['plain']).toMatchObject({ mode: 'interactive', approval_mode: 'ask' });
			expect(rows['approve-all']).toMatchObject({ mode: 'plan', approval_mode: 'auto-approve' });
			expect(rows['best-effort']).toMatchObject({ mode: 'autopilot', approval_mode: 'auto-deny' });
			expect(rows['both']).toMatchObject({ mode: 'autopilot', approval_mode: 'auto-approve' });

			// The retired boolean is gone, so the setting has exactly one home.
			const convColumns = (
				db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
			).map((r) => r.name);
			expect(convColumns).not.toContain('approve_all_tools');
			expect(convColumns).toContain('approval_mode');
			// No row anywhere still carries the retired mode value.
			expect(
				(
					db
						.prepare("SELECT COUNT(*) AS n FROM conversations WHERE mode = 'best-effort'")
						.get() as {
						n: number;
					}
				).n
			).toBe(0);

			const settingsRows = Object.fromEntries(
				(
					db
						.prepare('SELECT user_id, default_mode, default_approval_mode FROM user_settings')
						.all() as {
						user_id: string;
						default_mode: string;
						default_approval_mode: string;
					}[]
				).map((r) => [r.user_id, r])
			);
			expect(settingsRows['u1']).toMatchObject({
				default_mode: 'autopilot',
				default_approval_mode: 'auto-deny'
			});
			expect(settingsRows['u2']).toMatchObject({
				default_mode: 'plan',
				default_approval_mode: 'ask'
			});

			const templateRows = Object.fromEntries(
				(
					db.prepare('SELECT id, conversation_mode, approval_mode FROM prompt_templates').all() as {
						id: string;
						conversation_mode: string | null;
						approval_mode: string | null;
					}[]
				).map((r) => [r.id, r])
			);
			expect(templateRows['t-be']).toMatchObject({
				conversation_mode: 'autopilot',
				approval_mode: 'auto-deny'
			});
			// "No preference" stays NULL on both axes.
			expect(templateRows['t-none']).toMatchObject({
				conversation_mode: null,
				approval_mode: null
			});
		} finally {
			db.close();
		}
	});

	it('lists and revokes grants per user; prune drops expired rows', () => {
		const u = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'rival',
			githubId: 7,
			displayName: null,
			avatarUrl: null
		});
		const c = convs.create(u.id, { title: 'main', workdir: '/tmp', model: null });
		settings.addGrant({ userId: u.id, conversationId: c.id, tool: 'shell' });
		settings.addGrant({
			userId: u.id,
			conversationId: null,
			tool: 'read',
			expiresAt: Date.now() - 1000
		});
		settings.addGrant({ userId: other.id, conversationId: null, tool: 'shell' });

		// Each user only sees their own grants. Filter out the structured
		// seed grants that ensureLocalUser / upsertGithub install — this
		// test exercises the legacy `addGrant` path, not the seeded set.
		const mine = settings
			.listGrantsForUser(u.id)
			.filter((g) => g.scope === null && g.source !== 'seed');
		expect(mine.map((g) => g.tool).sort()).toEqual(['read', 'shell']);
		expect(
			settings
				.listGrantsForUser(other.id)
				.filter((g) => g.scope === null && g.source !== 'seed')
				.map((g) => g.tool)
		).toEqual(['shell']);

		// Conversation title comes through the join for conversation-scoped rows.
		const shellGrant = mine.find((g) => g.tool === 'shell')!;
		expect(shellGrant.conversationTitle).toBe('main');
		expect(shellGrant.conversationId).toBe(c.id);

		// Pruning drops the expired global 'read' grant, nothing else.
		const purged = settings.pruneExpiredGrants();
		expect(purged).toBe(1);
		expect(
			settings
				.listGrantsForUser(u.id)
				.filter((g) => g.scope === null && g.source !== 'seed')
				.map((g) => g.tool)
		).toEqual(['shell']);

		// Revoke is scoped to the owner — another user can't delete my row.
		const target = settings
			.listGrantsForUser(u.id)
			.filter((g) => g.scope === null && g.source !== 'seed')[0];
		expect(settings.revokeGrant(other.id, target.id)).toBe(false);
		expect(settings.revokeGrant(u.id, target.id)).toBe(true);
		expect(
			settings.listGrantsForUser(u.id).filter((g) => g.scope === null && g.source !== 'seed')
		).toEqual([]);
		// Idempotent.
		expect(settings.revokeGrant(u.id, target.id)).toBe(false);
	});

	it('updateGrant edits matchable fields in place, scoped to owner', () => {
		const u = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'rival2',
			githubId: 11,
			displayName: null,
			avatarUrl: null
		});
		settings.addGrant({
			userId: u.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'ls' }] } },
			decision: 'allow'
		});
		const grant = settings.listGrantsForUser(u.id).find((g) => g.tool === 'shell')!;
		const grantedAt = grant.grantedAt;

		// Foreign users can't edit my row.
		expect(
			settings.updateGrant(other.id, grant.id, {
				tool: 'shell',
				permissionKind: 'shell',
				scope: { kind: 'shell', rule: { command: [{ token: 'cat' }] } },
				decision: 'deny'
			})
		).toBe(false);

		// Owner can. granted_at is preserved, matchable fields change.
		expect(
			settings.updateGrant(u.id, grant.id, {
				tool: 'shell',
				permissionKind: 'shell',
				scope: { kind: 'shell', rule: { command: [{ token: 'cat' }] } },
				decision: 'deny',
				expiresAt: Date.now() + 60_000
			})
		).toBe(true);
		const after = settings.listGrantsForUser(u.id).find((g) => g.id === grant.id)!;
		expect(after.decision).toBe('deny');
		expect(after.scope).toEqual({ kind: 'shell', rule: { command: [{ token: 'cat' }] } });
		expect(after.expiresAt).not.toBeNull();
		expect(after.grantedAt).toBe(grantedAt);

		// Missing rowid returns false rather than throwing.
		expect(
			settings.updateGrant(u.id, 999_999, {
				tool: 'shell',
				permissionKind: 'shell',
				scope: { kind: 'shell', rule: { command: [{ token: 'x' }] } },
				decision: 'allow'
			})
		).toBe(false);
	});

	it('round-trips prompt grants and fails closed for malformed decisions', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'prompt grants', workdir: '/tmp', model: null });
		settings.addGrant({
			userId: u.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'npm *',
			decision: 'prompt',
			denyReason: 'npm scripts require review'
		});
		settings.addGrant({
			userId: u.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'node *',
			decision: 'deny',
			denyReason: 'node is blocked'
		});
		settings.addGrant({
			userId: u.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'ls *',
			decision: 'allow'
		});
		getDb()
			.prepare(
				`INSERT INTO permission_grants(
					user_id, conversation_id, tool, permission_kind, scope_pattern, decision, granted_at
				) VALUES (?, NULL, 'shell', 'shell', 'bogus *', 'unexpected', ?)`
			)
			.run(u.id, Date.now());

		expect(settings.matchGrantDetailed(u.id, c.id, 'shell', 'shell', 'npm install')).toMatchObject({
			outcome: 'prompt',
			denyReason: 'npm scripts require review',
			feedback: 'npm scripts require review'
		});
		expect(settings.matchGrantDetailed(u.id, c.id, 'shell', 'shell', 'node test')).toMatchObject({
			outcome: 'deny',
			denyReason: 'node is blocked'
		});
		expect(settings.matchGrant(u.id, c.id, 'shell', 'shell', 'ls src')).toBe('allow');
		expect(settings.matchGrant(u.id, c.id, 'shell', 'shell', 'bogus value')).toBe('deny');

		const listed = settings.listGrantsForUser(u.id).filter((g) => g.scope === null);
		expect(listed.find((g) => g.scopePattern === 'npm *')?.decision).toBe('prompt');
		expect(listed.find((g) => g.scopePattern === 'npm *')?.denyReason).toBe(
			'npm scripts require review'
		);
		expect(listed.find((g) => g.scopePattern === 'bogus *')?.decision).toBe('deny');
	});

	it('fails closed for malformed structured grant scopes instead of falling back to wildcard', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'malformed grant', workdir: '/tmp', model: null });
		getDb()
			.prepare(
				`INSERT INTO permission_grants(
					user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json, decision, granted_at
				) VALUES (?, NULL, 'shell', 'shell', NULL, ?, 'allow', ?)`
			)
			.run(u.id, '{"kind":"shell","rule":{"argv0":"node"}}', Date.now());

		expect(settings.matchGrant(u.id, c.id, 'shell', 'shell', 'node --version')).toBe('none');
		expect(settings.matchGrant(u.id, c.id, 'shell', 'shell', 'anything')).toBe('none');
	});

	it('archives and unarchives conversations and filters list accordingly', () => {
		const u = users.ensureLocalUser();
		const a = convs.create(u.id, { title: 'a', workdir: '/tmp', model: null });
		const b = convs.create(u.id, { title: 'b', workdir: '/tmp', model: null });

		expect(
			convs
				.list(u.id)
				.map((c) => c.id)
				.sort()
		).toEqual([a.id, b.id].sort());

		expect(convs.archive(a.id, u.id)).toBe(true);
		// Idempotent: archiving again returns false.
		expect(convs.archive(a.id, u.id)).toBe(false);

		const active = convs.list(u.id);
		expect(active.map((c) => c.id)).toEqual([b.id]);
		const all = convs.list(u.id, { includeArchived: true });
		expect(all.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
		expect(convs.get(a.id, u.id)?.archivedAt).toBeTypeOf('number');

		// Authorization: another user cannot archive/unarchive.
		const other = users.upsertGithub({
			githubLogin: 'other2',
			githubId: 43,
			displayName: null,
			avatarUrl: null
		});
		expect(convs.unarchive(a.id, other.id)).toBe(false);

		expect(convs.unarchive(a.id, u.id)).toBe(true);
		expect(convs.unarchive(a.id, u.id)).toBe(false);
		expect(convs.get(a.id, u.id)?.archivedAt).toBeNull();
	});

	it('saves and loads settings with defaults', () => {
		const u = users.ensureLocalUser();
		expect(settings.get(u.id)).toBeNull();
		const s = settings.defaults();
		expect(s.defaultPolicy).toBe('prompt');
		settings.save(u.id, {
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'autopilot',
			defaultApprovalMode: 'auto-deny',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'violet'
		});
		expect(settings.get(u.id)).toEqual({
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'autopilot',
			defaultApprovalMode: 'auto-deny',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'violet'
		});
		// '(use server default)' round-trips as NULL for every optional default.
		settings.save(u.id, {
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'autopilot',
			defaultApprovalMode: 'auto-deny',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'default'
		});
		expect(settings.get(u.id)?.accent).toBe('default');
	});

	it('coerces a stale legacy allow-readonly policy row to prompt', () => {
		const u = users.ensureLocalUser();
		settings.save(u.id, {
			defaultModel: null,
			defaultWorkdir: null,
			defaultConversationMode: 'interactive',
			defaultApprovalMode: 'ask',
			defaultPolicy: 'prompt',
			theme: 'dark',
			accent: 'default'
		});
		// Simulate a row that escaped migration 008.
		getDb()
			.prepare('UPDATE user_settings SET default_policy = ? WHERE user_id = ?')
			.run('allow-readonly', u.id);
		expect(settings.get(u.id)?.defaultPolicy).toBe('prompt');
	});

	it('recovers interrupted in-flight assistant messages and pending tool calls', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'recover', workdir: '/tmp', model: null });
		const assistant = messages.append(c.id, {
			role: 'assistant',
			content: 'partial',
			status: 'streaming'
		});
		messages.insertToolCall(assistant.id, {
			id: 1,
			tool: 'bash',
			argsJson: JSON.stringify({ command: 'sleep 10' }),
			resultJson: null,
			status: 'pending',
			startedAt: 100,
			endedAt: null,
			textOffset: 0,
			parentToolCallId: null
		});

		const recovered = messages.recoverInterruptedInFlight(1234);

		expect(recovered).toEqual({ messages: 1, toolCalls: 1 });
		const reloaded = messages.listByConversation(c.id).find((m) => m.id === assistant.id);
		expect(reloaded?.status).toBe('interrupted');
		expect(reloaded?.errorCode).toBe('server_restarted');
		expect(reloaded?.toolCalls?.[0]).toMatchObject({
			id: 1,
			status: 'error',
			endedAt: 1234
		});
	});

	it('persists background agent lifecycle outside tool_calls', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 'subagent lifecycle', workdir: '/tmp', model: null });
		const assistant = messages.append(c.id, {
			role: 'assistant',
			content: '',
			status: 'complete'
		});
		messages.insertToolCall(assistant.id, {
			id: 1,
			tool: 'task',
			argsJson: JSON.stringify({ mode: 'background' }),
			resultJson: JSON.stringify({ agent_id: 'agent-1' }),
			status: 'ok',
			startedAt: 100,
			endedAt: 110,
			textOffset: 0,
			parentToolCallId: null
		});

		messages.updateBackgroundAgentLifecycle(1, 'agent-1', 'running', 120);
		messages.updateBackgroundAgentLifecycle(1, 'agent-1', 'completed', 130);

		const toolColumns = (
			getDb().prepare(`PRAGMA table_info(tool_calls)`).all() as { name: string }[]
		).map((r) => r.name);
		expect(toolColumns).not.toContain('subagent_status');

		const reloaded = messages.listByConversation(c.id).find((m) => m.id === assistant.id);
		expect(reloaded?.toolCalls?.[0]).toMatchObject({
			id: 1,
			status: 'ok',
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-1',
			backgroundAgentStartedAt: 120,
			backgroundAgentEndedAt: 130
		});
		expect(messages.getToolCallForConversation(c.id, 1)).toMatchObject({
			id: 1,
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-1',
			backgroundAgentStartedAt: 120,
			backgroundAgentEndedAt: 130
		});
	});

	it('does not let late running lifecycle events clobber terminal states', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 'subagent lifecycle race',
			workdir: '/tmp',
			model: null
		});
		const assistant = messages.append(c.id, {
			role: 'assistant',
			content: '',
			status: 'complete'
		});
		messages.insertToolCall(assistant.id, {
			id: 1,
			tool: 'task',
			argsJson: JSON.stringify({ mode: 'background' }),
			resultJson: null,
			status: 'ok',
			startedAt: 100,
			endedAt: 110,
			textOffset: 0,
			parentToolCallId: null
		});

		messages.updateBackgroundAgentLifecycle(1, 'agent-race', 'completed', 130);
		messages.updateBackgroundAgentLifecycle(1, 'agent-race', 'running', 120);

		const reloaded = messages.listByConversation(c.id).find((m) => m.id === assistant.id);
		expect(reloaded?.toolCalls?.[0]).toMatchObject({
			id: 1,
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-race',
			backgroundAgentStartedAt: 120,
			backgroundAgentEndedAt: 130
		});
	});

	it('handles conversations whose id lists exceed the SQLite variable limit', () => {
		// More ids than SQLITE_MAX_VARIABLE_NUMBER (often 999): a single
		// IN (?, ...) list would throw SQLITE_RANGE without batching.
		const total = 2100;
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 'huge conversation',
			workdir: '/tmp',
			model: null
		});

		const created: string[] = [];
		for (let i = 0; i < total; i++) {
			const m = messages.append(c.id, {
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `msg ${i}`,
				status: 'complete'
			});
			created.push(m.id);
			messages.insertToolCall(m.id, {
				id: i + 1,
				tool: 'task',
				argsJson: '{}',
				resultJson: null,
				status: 'ok',
				startedAt: i,
				endedAt: i,
				textOffset: 0,
				parentToolCallId: null
			});
			messages.insertReasoningBlock(m.id, {
				id: i + 1,
				segmentIndex: 0,
				text: 'thinking',
				kind: 'reasoning',
				textOffset: 0,
				startedAt: i,
				durationMs: 1,
				parentToolCallId: null
			});
		}

		const loaded = messages.listByConversation(c.id);
		expect(loaded).toHaveLength(total);
		expect(loaded.every((m) => m.toolCalls?.length === 1)).toBe(true);
		expect(loaded.every((m) => m.reasoningBlocks?.length === 1)).toBe(true);

		// Truncating after the very first message must delete every later row
		// (also exceeding the variable limit) without throwing.
		const ok = messages.truncateAfterMessage(c.id, created[0]);
		expect(ok).toBe(true);
		const afterTruncate = messages.listByConversation(c.id);
		expect(afterTruncate).toHaveLength(1);
		expect(afterTruncate[0].id).toBe(created[0]);
	});
});
