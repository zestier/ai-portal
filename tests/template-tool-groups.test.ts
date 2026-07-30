import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

describe('chat template tool-group presets', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-template-tool-groups-');
	});

	describe('repo round-trip', () => {
		it('defaults chat templates to an empty disabled set', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, { title: 'Story', prompt: 'Tell a story.' });
			expect(tpl.disabledToolGroups).toEqual([]);
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([]);
		});

		it('persists and sanitizes a chat template preset (canonical order, unknowns dropped)', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, {
				title: 'Story',
				prompt: 'Tell a story.',
				disabledToolGroups: ['tickets', 'bogus', 'git', 'git']
			});
			expect(tpl.disabledToolGroups).toEqual(['git', 'tickets']);
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual(['git', 'tickets']);
		});

		it('updates a chat template preset and can clear it', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, { title: 'Story', prompt: 'Tell a story.' });
			templates.update(tpl.id, user.id, { disabledToolGroups: ['git', 'tickets'] });
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual(['git', 'tickets']);
			templates.update(tpl.id, user.id, { disabledToolGroups: [] });
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([]);
		});

		it('keeps ticket-action templates empty even if a preset is passed', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, {
				type: 'ticket-action',
				title: 'Do',
				prompt: 'Do the ticket.',
				disabledToolGroups: ['git']
			});
			expect(tpl.disabledToolGroups).toEqual([]);
			// And an update on a ticket-action template can't set it either.
			templates.update(tpl.id, user.id, { disabledToolGroups: ['git'] });
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual([]);
		});
	});

	describe('template_create / template_update tools', () => {
		async function buildTools(userId: string) {
			const mod = await import('../src/lib/server/tools/prompt-templates');
			return mod.buildPromptTemplateTools({ userId });
		}

		it('creates a chat template with a validated preset', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const user = users.ensureLocalUser();
			const tools = await buildTools(user.id);
			const create = tools.find((t) => t.name === 'template_create');
			const res = await create!.handler({
				type: 'chat',
				title: 'Story',
				prompt: 'Tell a story.',
				disabledToolGroups: ['git', 'tickets']
			});
			expect(res.ok).toBe(true);
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const list = templates.list(user.id, { type: 'chat' });
			expect(list[0]?.disabledToolGroups).toEqual(['git', 'tickets']);
		});

		it('rejects unknown group ids at the tool boundary', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const user = users.ensureLocalUser();
			const tools = await buildTools(user.id);
			const create = tools.find((t) => t.name === 'template_create');
			await expect(
				create!.handler({
					type: 'chat',
					title: 'Story',
					prompt: 'Tell a story.',
					disabledToolGroups: ['not-a-group']
				})
			).rejects.toThrow();
		});

		it('updates a chat template preset via the tool', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, { title: 'Story', prompt: 'Tell a story.' });
			const tools = await buildTools(user.id);
			const update = tools.find((t) => t.name === 'template_update');
			const res = await update!.handler({ id: tpl.id, disabledToolGroups: ['memory'] });
			expect(res.ok).toBe(true);
			expect(templates.get(tpl.id, user.id)?.disabledToolGroups).toEqual(['memory']);
		});
	});

	describe('launch seeds the conversation', () => {
		it('copies a chat template preset onto a conversation created with promptTemplateId', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const { POST } = await import('../src/routes/api/conversations/+server');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, {
				title: 'Story',
				prompt: 'Tell a story.',
				disabledToolGroups: ['git', 'tickets']
			});

			const res = await POST({
				locals: { userId: user.id, user: { githubLogin: 'local' } },
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Story chat', promptTemplateId: tpl.id })
				}),
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof POST>[0]);
			const body = await (res as Response).json();
			expect(body.conversation.disabledToolGroups).toEqual(['git', 'tickets']);
		});

		it('seeds nothing when the template belongs to another user', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const { POST } = await import('../src/routes/api/conversations/+server');
			const user = users.ensureLocalUser();
			const other = users.upsertGithub({
				githubLogin: 'other',
				githubId: 555,
				displayName: null,
				avatarUrl: null
			});
			const tpl = templates.create(other.id, {
				title: 'Story',
				prompt: 'Tell a story.',
				disabledToolGroups: ['git']
			});

			const res = await POST({
				locals: { userId: user.id, user: { githubLogin: 'local' } },
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Story chat', promptTemplateId: tpl.id })
				}),
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof POST>[0]);
			const body = await (res as Response).json();
			expect(body.conversation.disabledToolGroups).toEqual([]);
		});

		it('seeds nothing when no promptTemplateId is supplied', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const { POST } = await import('../src/routes/api/conversations/+server');
			const user = users.ensureLocalUser();
			const res = await POST({
				locals: { userId: user.id, user: { githubLogin: 'local' } },
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Plain chat' })
				}),
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof POST>[0]);
			const body = await (res as Response).json();
			expect(body.conversation.disabledToolGroups).toEqual([]);
		});

		it('creates a managed worktree when the template pins workspaceMode: worktree', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const { POST } = await import('../src/routes/api/conversations/+server');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, {
				title: 'Isolated',
				prompt: 'Work in isolation.',
				workspaceMode: 'worktree'
			});

			const res = await POST({
				locals: { userId: user.id, user: { githubLogin: 'local' } },
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Isolated chat', promptTemplateId: tpl.id })
				}),
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof POST>[0]);
			const body = await (res as Response).json();
			expect(body.conversation.workspaceKind).toBe('managed-worktree');
		});

		it('lets an explicit workspace override the template preference', async () => {
			const users = await import('../src/lib/server/db/repos/users');
			const templates = await import('../src/lib/server/db/repos/prompt-templates');
			const { POST } = await import('../src/routes/api/conversations/+server');
			const user = users.ensureLocalUser();
			const tpl = templates.create(user.id, {
				title: 'Isolated',
				prompt: 'Work in isolation.',
				workspaceMode: 'worktree'
			});

			// A review launch that switched back to the shared checkout must win.
			const res = await POST({
				locals: { userId: user.id, user: { githubLogin: 'local' } },
				request: new Request('http://localhost/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						title: 'Shared chat',
						promptTemplateId: tpl.id,
						workspace: { kind: 'shared' }
					})
				}),
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof POST>[0]);
			const body = await (res as Response).json();
			expect(body.conversation.workspaceKind).toBe('shared');
		});
	});
});
