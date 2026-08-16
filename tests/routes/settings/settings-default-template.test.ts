import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from '../../helpers/env';

// Per-user default prompt template (T30 / R1). The `user_settings` table gains
// `default_prompt_template_id` via migration 003; the settings repo must
// round-trip it through save/get/defaults, and the Settings ?/save action must
// preserve it (it is NOT part of the general save schema, so an unrelated
// settings save must not wipe it).

describe('settings default prompt template', () => {
	let userId: number;

	beforeEach(async () => {
		await setupLocalEnv('portal-settings-default-template-');
		const users = await import('../../../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
	});

	it('round-trips a stored default template id and defaults to null', async () => {
		const settings = await import('../../../src/lib/server/db/repos/settings');
		expect(settings.defaults().defaultPromptTemplateId).toBeNull();
		// Fresh user has no row yet.
		expect(settings.get(userId)).toBeNull();

		settings.save(userId, { ...settings.defaults(), defaultPromptTemplateId: 'PT7' });
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe('PT7');
	});

	it('saving null clears a previously stored default', async () => {
		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.save(userId, { ...settings.defaults(), defaultPromptTemplateId: 'PT7' });
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe('PT7');

		settings.save(userId, { ...settings.defaults(), defaultPromptTemplateId: null });
		expect(settings.get(userId)?.defaultPromptTemplateId).toBeNull();
	});

	it('general ?/save preserves an existing default template id', async () => {
		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.save(userId, { ...settings.defaults(), defaultPromptTemplateId: 'PT7' });

		const mod = await import('../../../src/routes/settings/+page.server');
		const form = new FormData();
		form.set('defaultConversationMode', 'autopilot');
		form.set('defaultApprovalMode', 'auto-approve');
		form.set('defaultPolicy', 'prompt');
		form.set('theme', 'dark');
		form.set('accent', 'default');
		const result = (await mod.actions.save({
			request: new Request('http://localhost/settings', { method: 'POST', body: form }),
			locals: { userId },
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof mod.actions.save>[0])) as {
			ok: boolean;
		};

		expect(result.ok).toBe(true);
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe('PT7');
		// The rest of the save still landed.
		expect(settings.get(userId)?.defaultConversationMode).toBe('autopilot');
	});
});

// The ?/saveDefaultPromptTemplate action (Settings → Prompts "Default template
// for New chat"). Raw id empty → clears; otherwise must resolve to an open chat
// template (custom PT<number> owned by the caller, or built-in -1..-4).
describe('settings saveDefaultPromptTemplate action', () => {
	let userId: number;

	beforeEach(async () => {
		await setupLocalEnv('portal-settings-default-template-');
		const users = await import('../../../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
	});

	async function saveDefault(id: string | null): Promise<{ ok: boolean; status?: number }> {
		const mod = await import('../../../src/routes/settings/+page.server');
		const form = new FormData();
		if (id !== null) form.set('defaultPromptTemplateId', id);
		const result = (await mod.actions.saveDefaultPromptTemplate({
			request: new Request('http://localhost/settings', { method: 'POST', body: form }),
			locals: { userId }
		} as unknown as Parameters<typeof mod.actions.saveDefaultPromptTemplate>[0])) as
			| { ok: boolean }
			| { status: number };
		return 'status' in result ? { ok: false, status: result.status } : result;
	}

	it('stores a valid custom chat template id', async () => {
		const promptTemplates = await import('../../../src/lib/server/db/repos/prompt-templates');
		const tpl = promptTemplates.create(userId, { title: 'Story', prompt: 'Tell a story.' });
		expect(tpl.id).toMatch(/^PT[1-9][0-9]*$/);

		const result = await saveDefault(tpl.id);
		expect(result.ok).toBe(true);

		const settings = await import('../../../src/lib/server/db/repos/settings');
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe(tpl.id);
	});

	it('stores a built-in template id', async () => {
		const result = await saveDefault('-2');
		expect(result.ok).toBe(true);

		const settings = await import('../../../src/lib/server/db/repos/settings');
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe('-2');
	});

	it('clears the default when the id is empty', async () => {
		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.save(userId, { ...settings.defaults(), defaultPromptTemplateId: 'PT7' });
		expect(settings.get(userId)?.defaultPromptTemplateId).toBe('PT7');

		const result = await saveDefault('');
		expect(result.ok).toBe(true);
		expect(settings.get(userId)?.defaultPromptTemplateId).toBeNull();
	});

	it('rejects a stale (archived) custom template id with 400', async () => {
		const promptTemplates = await import('../../../src/lib/server/db/repos/prompt-templates');
		const tpl = promptTemplates.create(userId, { title: 'Story', prompt: 'Tell a story.' });
		promptTemplates.archive(tpl.id, userId);

		const result = await saveDefault(tpl.id);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(400);
	});

	it('rejects a ticket-action template id with 400', async () => {
		const promptTemplates = await import('../../../src/lib/server/db/repos/prompt-templates');
		const action = promptTemplates.create(userId, {
			type: 'ticket-action',
			title: 'Do',
			prompt: 'Do the ticket.'
		});

		const result = await saveDefault(action.id);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(400);
	});

	it('rejects a malformed id with 400', async () => {
		const result = await saveDefault('not-a-template');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(400);
	});
});
