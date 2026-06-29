import { describe, expect, it, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

async function setup() {
	await setupLocalEnv('portal-template-tools-');
	const users = await import('../src/lib/server/db/repos/users');
	const { buildPromptTemplateTools } = await import('../src/lib/server/tools/prompt-templates');
	const user = users.ensureLocalUser();
	const other = users.upsertGithub({
		githubLogin: 'template-rival',
		githubId: 909,
		displayName: null,
		avatarUrl: null
	});
	const tools = buildPromptTemplateTools({ userId: user.id });
	const byName = (n: string) => tools.find((t) => t.name === n)!;
	return { user, other, tools, byName };
}

describe('prompt-template tools', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-template-tools-');
	});

	it('exposes the five expected tools with correct permission behavior', async () => {
		const { tools } = await setup();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			'template_builtins',
			'template_create',
			'template_get',
			'template_list',
			'template_update'
		]);
		const writes = ['template_create', 'template_update'];
		const reads = ['template_list', 'template_get', 'template_builtins'];
		for (const w of writes)
			expect(tools.find((t) => t.name === w)!.permissionBehavior).toBe('always-prompt');
		for (const r of reads)
			expect(tools.find((t) => t.name === r)!.permissionBehavior).toBe('never-prompt');
	});

	it('CRUD: create, list, get, update, archive a chat template', async () => {
		const { byName } = await setup();
		const created = await byName('template_create').handler({
			title: 'My preset',
			prompt: 'Do the thing carefully.'
		});
		expect(created.ok).toBe(true);
		const id = created.ok && (created.result as { id: string }).id;
		expect(id).toBeTruthy();

		const listed = await byName('template_list').handler({ type: 'chat' });
		const rows = listed.ok && (listed.result as { templates: { id: string }[] }).templates;
		expect((rows as { id: string }[]).some((t) => t.id === id)).toBe(true);

		const got = await byName('template_get').handler({ id });
		expect(got.ok && (got.result as { title: string }).title).toBe('My preset');

		const updated = await byName('template_update').handler({ id, title: 'Renamed preset' });
		expect(updated.ok && (updated.result as { title: string }).title).toBe('Renamed preset');

		const archived = await byName('template_update').handler({ id, status: 'archived' });
		expect(archived.ok && (archived.result as { status: string }).status).toBe('archived');
		const openList = await byName('template_list').handler({});
		const openRows = openList.ok && (openList.result as { templates: { id: string }[] }).templates;
		expect((openRows as { id: string }[]).some((t) => t.id === id)).toBe(false);

		// Archive is reversible via template_update status -> open.
		const reopened = await byName('template_update').handler({ id, status: 'open' });
		expect(reopened.ok && (reopened.result as { status: string }).status).toBe('open');
	});

	it('lists ticket-action defaults (lazily seeded) and built-ins', async () => {
		const { byName } = await setup();
		const listed = await byName('template_list').handler({ type: 'ticket-action' });
		const rows = listed.ok && (listed.result as { templates: { title: string }[] }).templates;
		expect((rows as { title: string }[]).map((t) => t.title).sort()).toEqual([
			'Do',
			'Draft',
			'Refine'
		]);

		const builtins = await byName('template_builtins').handler({});
		const data = builtins.ok && (builtins.result as { chat: unknown[]; ticketAction: unknown[] });
		expect((data as { chat: unknown[] }).chat.length).toBeGreaterThan(0);
		expect((data as { ticketAction: unknown[] }).ticketAction.length).toBe(3);
	});

	it('rejects unknown placeholders per type', async () => {
		const { byName } = await setup();
		const badChat = await byName('template_create').handler({
			title: 'bad',
			prompt: 'hi {{ticket.title}}'
		});
		expect(badChat.ok).toBe(false);
		expect(!badChat.ok && badChat.error.message).toMatch(/placeholder/i);

		const okTicket = await byName('template_create').handler({
			type: 'ticket-action',
			title: 'good',
			prompt: 'Work on {{ticket.title}}'
		});
		expect(okTicket.ok).toBe(true);

		const badTicket = await byName('template_create').handler({
			type: 'ticket-action',
			title: 'bad ticket',
			prompt: 'Work on {{ticket.nope}}'
		});
		expect(badTicket.ok).toBe(false);
		expect(!badTicket.ok && badTicket.error.message).toMatch(/ticket\.nope/);
	});

	it('scopes reads/writes to the authed user', async () => {
		const { byName, other } = await setup();
		const { buildPromptTemplateTools } = await import('../src/lib/server/tools/prompt-templates');
		const created = await byName('template_create').handler({ title: 'mine', prompt: 'x' });
		const id = created.ok && (created.result as { id: string }).id;

		const otherTools = buildPromptTemplateTools({ userId: other.id });
		const get = otherTools.find((t) => t.name === 'template_get')!;
		const res = await get.handler({ id });
		expect(res.ok).toBe(false);
		expect(!res.ok && res.error.message).toMatch(/not found/i);

		// Writes are scoped too: another user can neither update nor archive it.
		const update = otherTools.find((t) => t.name === 'template_update')!;
		const updRes = await update.handler({ id, title: 'hijacked' });
		expect(updRes.ok).toBe(false);
		expect(!updRes.ok && updRes.error.message).toMatch(/not found/i);
		// And the original is untouched.
		const stillMine = await byName('template_get').handler({ id });
		expect(stillMine.ok && (stillMine.result as { title: string }).title).toBe('mine');
	});
});
