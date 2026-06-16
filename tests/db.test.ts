import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/lib/server/db';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as settings from '../src/lib/server/db/repos/settings';
import { setupLocalEnv } from './helpers/env';

describe('db migrations + repos', () => {
	beforeEach(async () => {
		await setupLocalEnv();
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
		const c = convs.create(u.id, { title: 't', workdir: '/tmp', model: 'm' });
		expect(c.provider).toBe('copilot');
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
		expect(convs.get(c.id, u.id)?.provider).toBe('copilot');
	});

	it('round-trips conversation provider separately from model', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 'local',
			workdir: '/tmp',
			provider: 'openai-compatible',
			model: 'local-model'
		});
		expect(convs.get(c.id, u.id)).toMatchObject({
			provider: 'openai-compatible',
			model: 'local-model'
		});
	});

	it('round-trips the best-effort session mode', () => {
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, {
			title: 't',
			workdir: '/tmp',
			model: null,
			mode: 'autopilot'
		});
		expect(convs.get(c.id, u.id)?.mode).toBe('autopilot');
		expect(convs.updateSessionSettings(c.id, u.id, { mode: 'best-effort' })).toBe(true);
		expect(convs.get(c.id, u.id)?.mode).toBe('best-effort');
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
			defaultProvider: 'openai-compatible',
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'best-effort',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'violet',
			defaultMemoryExtractorModel: 'harvester-x',
			defaultMemoryExtractorBackend: 'openai-compatible-tools'
		});
		expect(settings.get(u.id)).toEqual({
			defaultProvider: 'openai-compatible',
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'best-effort',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'violet',
			defaultMemoryExtractorModel: 'harvester-x',
			defaultMemoryExtractorBackend: 'openai-compatible-tools'
		});
		// '(use server default)' round-trips as NULL for both extractor defaults.
		settings.save(u.id, {
			defaultProvider: 'openai-compatible',
			defaultModel: 'claude',
			defaultWorkdir: null,
			defaultConversationMode: 'best-effort',
			defaultPolicy: 'allow-all',
			theme: 'light',
			accent: 'default',
			defaultMemoryExtractorModel: null,
			defaultMemoryExtractorBackend: null
		});
		expect(settings.get(u.id)?.defaultMemoryExtractorModel).toBeNull();
		expect(settings.get(u.id)?.defaultMemoryExtractorBackend).toBeNull();
	});

	it('coerces a stale legacy allow-readonly policy row to prompt', () => {
		const u = users.ensureLocalUser();
		settings.save(u.id, {
			defaultProvider: 'copilot',
			defaultModel: null,
			defaultWorkdir: null,
			defaultConversationMode: 'interactive',
			defaultPolicy: 'prompt',
			theme: 'dark',
			accent: 'default',
			defaultMemoryExtractorModel: null,
			defaultMemoryExtractorBackend: null
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
			id: 'tool-pending',
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
			id: 'tool-pending',
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
			id: 'task-background',
			tool: 'task',
			argsJson: JSON.stringify({ mode: 'background' }),
			resultJson: JSON.stringify({ agent_id: 'agent-1' }),
			status: 'ok',
			startedAt: 100,
			endedAt: 110,
			textOffset: 0,
			parentToolCallId: null
		});

		messages.updateBackgroundAgentLifecycle('task-background', 'agent-1', 'running', 120);
		messages.updateBackgroundAgentLifecycle('task-background', 'agent-1', 'completed', 130);

		const toolColumns = (
			getDb().prepare(`PRAGMA table_info(tool_calls)`).all() as { name: string }[]
		).map((r) => r.name);
		expect(toolColumns).not.toContain('subagent_status');

		const reloaded = messages.listByConversation(c.id).find((m) => m.id === assistant.id);
		expect(reloaded?.toolCalls?.[0]).toMatchObject({
			id: 'task-background',
			status: 'ok',
			backgroundAgentStatus: 'completed',
			backgroundAgentId: 'agent-1',
			backgroundAgentStartedAt: 120,
			backgroundAgentEndedAt: 130
		});
		expect(messages.getToolCallForConversation(c.id, 'task-background')).toMatchObject({
			id: 'task-background',
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
			id: 'task-race',
			tool: 'task',
			argsJson: JSON.stringify({ mode: 'background' }),
			resultJson: null,
			status: 'ok',
			startedAt: 100,
			endedAt: 110,
			textOffset: 0,
			parentToolCallId: null
		});

		messages.updateBackgroundAgentLifecycle('task-race', 'agent-race', 'completed', 130);
		messages.updateBackgroundAgentLifecycle('task-race', 'agent-race', 'running', 120);

		const reloaded = messages.listByConversation(c.id).find((m) => m.id === assistant.id);
		expect(reloaded?.toolCalls?.[0]).toMatchObject({
			id: 'task-race',
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
				id: `tool-${i}`,
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
				id: `reason-${i}`,
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
